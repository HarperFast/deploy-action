import { resolve } from 'node:path';
import type { ActionResult } from './deploy.ts';
import { GitHubApiError, type GitHubApi, type IssueComment } from './githubApi.ts';
import type { RunHarper } from './harperCli.ts';
import type { Inputs } from './inputs.ts';
import type { WorkflowLog } from './workflowCommands.ts';

const CLEANUP_ATTEMPTS = 5;
const CLEANUP_RETRY_MS = 30_000;
const PREVIEW_URL = /^Preview: (\S+)$/m;
const TRUSTED_COMMENTERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface PreviewContext {
	inputs: Inputs;
	harper: RunHarper;
	github: GitHubApi;
	log: WorkflowLog;
	repository: string;
	runUrl: string;
	sleep: (milliseconds: number) => Promise<void>;
}

interface PullRequestEvent {
	action: string;
	number: number;
	branch: string;
	sha: string;
	headRepository?: string;
}

interface ListedPreview {
	name?: string;
	preview?: { app?: string; pr?: number; repository?: string };
}

const short = (sha: string) => sha.slice(0, 7);
const commentMarker = (app: string) => `<!-- harper-deploy-action:preview:${app} -->`;
const deploymentTask = (app: string, pullRequest: number) => `preview:${app}:pr-${pullRequest}`;

function readPullRequestEvent(payload: any): PullRequestEvent {
	const pullRequest = payload?.pull_request;
	if (typeof pullRequest?.number !== 'number' || typeof pullRequest?.head?.sha !== 'string') {
		throw new Error('The event payload has no pull_request');
	}
	return {
		action: String(payload.action),
		number: pullRequest.number,
		branch: String(pullRequest.head.ref),
		sha: pullRequest.head.sha,
		headRepository: pullRequest.head.repo?.full_name,
	};
}

/** GitHub surfaces report on the deploy; losing one must not fail a deploy or a cleanup that worked. */
async function bestEffort<T>(context: PreviewContext, what: string, attempt: () => Promise<T>): Promise<T | undefined> {
	try {
		return await attempt();
	} catch (error) {
		context.log.warning(`Could not ${what}: ${(error as Error).message}`);
		return undefined;
	}
}

/** A bot comments only through an App installed on the repository, as the default token does; a stranger cannot. */
function isOurComment(comment: IssueComment, marker: string): boolean {
	const trusted = comment.user?.type === 'Bot' || TRUSTED_COMMENTERS.has(comment.author_association ?? 'NONE');
	return trusted && Boolean(comment.body?.startsWith(marker));
}

async function postComment(
	context: PreviewContext,
	pullRequest: number,
	message: string,
	{ create }: { create: boolean }
): Promise<void> {
	const { github, inputs } = context;
	if (!inputs.comment) return;
	await bestEffort(context, 'update the PR comment', async () => {
		const marker = commentMarker(inputs.app);
		const body = `${marker}\n${message}`;
		for await (const comment of github.comments(pullRequest)) {
			if (isOurComment(comment, marker)) return github.updateComment(comment.id, body);
		}
		return create ? github.createComment(pullRequest, body) : undefined;
	});
}

async function startDeployment(context: PreviewContext, pullRequest: PullRequestEvent): Promise<number | undefined> {
	const { github, inputs, runUrl } = context;
	if (!inputs.githubDeployment) return undefined;
	const description = `Preview of ${inputs.app} for PR #${pullRequest.number}`;
	const deployment = await bestEffort(context, 'create the GitHub Deployment', () =>
		github.createDeployment({
			ref: pullRequest.sha,
			task: deploymentTask(inputs.app, pullRequest.number),
			environment: inputs.deploymentEnvironment,
			description,
			payload: { app: inputs.app, pr: pullRequest.number },
		})
	);
	if (deployment) {
		await bestEffort(context, 'update the GitHub Deployment', () =>
			github.setDeploymentStatus(deployment.id, { state: 'in_progress', description, log_url: runUrl })
		);
	}
	return deployment?.id;
}

async function finishDeployment(context: PreviewContext, id: number | undefined, state: string, url?: string) {
	if (id === undefined) return;
	await bestEffort(context, 'update the GitHub Deployment', () =>
		context.github.setDeploymentStatus(id, {
			state,
			description: `Preview of ${context.inputs.app}: ${state}`,
			log_url: context.runUrl,
			...(url && { environment_url: url }),
		})
	);
}

/**
 * Everything older than an inactive Deployment is inactive, so the scan stops at the first one. Retiring oldest first
 * keeps that true when a run fails partway.
 */
async function retireDeployments(context: PreviewContext, pullRequest: number, keep?: number): Promise<void> {
	const { github, inputs, runUrl } = context;
	if (!inputs.githubDeployment) return;
	await bestEffort(context, 'retire earlier GitHub Deployments', async () => {
		const task = deploymentTask(inputs.app, pullRequest);
		const active: number[] = [];
		for await (const deployment of github.deployments(task, inputs.deploymentEnvironment)) {
			if (deployment.id === keep) continue;
			if ((await github.latestDeploymentStatus(deployment.id))?.state === 'inactive') break;
			active.push(deployment.id);
		}
		for (const id of active.reverse()) {
			await github.setDeploymentStatus(id, {
				state: 'inactive',
				description: `Preview of ${inputs.app} retired`,
				log_url: runUrl,
			});
		}
	});
}

async function reportRemoved(context: PreviewContext, pullRequest: number): Promise<void> {
	await retireDeployments(context, pullRequest);
	const message = `**\`${context.inputs.app}\` preview removed:** this PR closed.`;
	await postComment(context, pullRequest, message, { create: false });
}

function dropArguments(app: string, pullRequest: number): string[] {
	return ['preview', 'drop', `app=${app}`, `pr=${pullRequest}`];
}

/** A deploy still holding the preview answers 409 until it finishes, so a failed drop is retried; a reopened PR keeps its preview. */
async function dropClosedPreview(context: PreviewContext, pullRequest: number): Promise<ActionResult> {
	const { github, harper, inputs, log, sleep } = context;
	let lastFailure = '';
	for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt++) {
		if (attempt > 1) await sleep(CLEANUP_RETRY_MS);
		let state: string;
		try {
			({ state } = await github.pullRequest(pullRequest));
		} catch (error) {
			lastFailure = `the PR could not be read: ${(error as Error).message}`;
			log.warning(`Could not read PR #${pullRequest}: ${(error as Error).message}`);
			continue;
		}
		if (state !== 'closed') {
			log.notice(`PR #${pullRequest} is ${state} again, so it keeps its preview.`);
			return { outcome: 'kept' };
		}
		const { exitCode } = await harper(dropArguments(inputs.app, pullRequest));
		if (exitCode === 0) {
			await reportRemoved(context, pullRequest);
			return { outcome: 'dropped' };
		}
		lastFailure = `harper preview drop exited with ${exitCode}`;
	}
	throw new Error(
		`The preview of PR #${pullRequest} was not dropped after ${CLEANUP_ATTEMPTS} attempts; last, ${lastFailure}`
	);
}

function previewDeployArguments({ inputs }: PreviewContext, pullRequest: PullRequestEvent): string[] {
	return [
		'preview',
		'deploy',
		`app=${inputs.app}`,
		`pr=${pullRequest.number}`,
		`branch=${pullRequest.branch}`,
		...(inputs.byRef ? ['by_ref=true', `ref=${pullRequest.sha}`] : [`sha=${pullRequest.sha}`]),
		...(inputs.domain ? [`domain=${inputs.domain}`] : []),
		...(inputs.label ? [`label=${inputs.label}`] : []),
		...(inputs.ttl ? [`ttl=${inputs.ttl}`] : []),
		...(inputs.credential ? ['credential=true'] : []),
		...(inputs.branchedDatabases ? [] : ['branchedDatabases=false']),
		...inputs.args,
	];
}

async function closedMeanwhile(context: PreviewContext, pullRequest: number): Promise<boolean> {
	try {
		return (await context.github.pullRequest(pullRequest)).state === 'closed';
	} catch (error) {
		// Its close event, or the cluster's expiry, still removes the preview.
		context.log.warning(`Could not check PR #${pullRequest} after deploying: ${(error as Error).message}`);
		return false;
	}
}

async function deployPreview(context: PreviewContext, pullRequest: PullRequestEvent): Promise<ActionResult> {
	const { github, harper, inputs, log, runUrl } = context;
	const { number, sha } = pullRequest;
	const current = await github.pullRequest(number);
	if (current.state !== 'open' || current.head.sha !== sha) {
		log.notice(`Skipping ${short(sha)}: PR #${number} is ${current.state} at ${short(current.head.sha)}.`);
		return { outcome: 'skipped' };
	}

	const deployment = await startDeployment(context, pullRequest);
	let stdout = '';
	let deployFailure: Error | undefined;
	try {
		const result = await harper(previewDeployArguments(context, pullRequest), {
			cwd: inputs.byRef ? undefined : resolve(inputs.path),
		});
		stdout = result.stdout;
		if (result.exitCode !== 0) deployFailure = new Error(`harper preview deploy exited with ${result.exitCode}`);
	} catch (error) {
		deployFailure = error as Error;
	}

	// Closed while this deployed: the close event's cleanup may have run first, and found nothing to drop.
	if (await closedMeanwhile(context, number)) {
		const { outcome } = await dropClosedPreview(context, number).catch(async (error) => {
			await finishDeployment(context, deployment, 'failure');
			throw deployFailure ?? error;
		});
		if (outcome === 'dropped') {
			if (deployFailure) throw deployFailure;
			return { outcome };
		}
	}
	if (deployFailure) {
		await finishDeployment(context, deployment, 'failure');
		const message = `**\`${inputs.app}\` preview failed** at \`${short(sha)}\`: see the [workflow run](${runUrl}).`;
		await postComment(context, number, message, { create: true });
		throw deployFailure;
	}

	const url = stdout.match(PREVIEW_URL)?.[1];
	if (!url) log.warning('harper preview deploy printed no preview URL');
	await finishDeployment(context, deployment, 'success', url);
	await retireDeployments(context, number, deployment);
	const message =
		`**\`${inputs.app}\` preview:** ${url ?? 'deployed'}\n\n` +
		`Commit \`${short(sha)}\`, [workflow run](${runUrl}). It updates on each push and is removed when this PR closes.`;
	await postComment(context, number, message, { create: true });
	// A cleanup that ran while this reported could have finished first, leaving the report above as the last word.
	if (await closedMeanwhile(context, number)) {
		const { outcome } = await dropClosedPreview(context, number);
		if (outcome === 'dropped') return { outcome };
	}
	return { outcome: 'deployed', url };
}

async function listPreviews({ harper, inputs }: PreviewContext): Promise<ListedPreview[]> {
	const { exitCode, stdout } = await harper(['get_components', 'json=true'], { quiet: true });
	if (exitCode !== 0) throw new Error(`harper get_components exited with ${exitCode}`);
	let entries: ListedPreview[];
	try {
		entries = JSON.parse(stdout).entries ?? [];
	} catch (cause) {
		throw new Error('harper get_components json=true printed no JSON', { cause });
	}
	return entries.filter((entry) => entry.preview?.app === inputs.app);
}

async function sweepPreviews(context: PreviewContext): Promise<ActionResult> {
	const { github, harper, inputs, log, repository } = context;
	const failed: string[] = [];
	let dropped = 0;
	for (const { name, preview } of await listPreviews(context)) {
		const pullRequest = preview?.pr;
		if (typeof pullRequest !== 'number' || name !== `${inputs.app}-pr-${pullRequest}`) continue;
		// Another repository's PR numbers say nothing about this one's, and the CLI records the repository on every CI deploy.
		if (preview?.repository !== repository) continue;
		let state: string;
		try {
			({ state } = await github.pullRequest(pullRequest));
		} catch (error) {
			if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
			log.warning(`PR #${pullRequest} does not exist here, so ${name} is left to expire.`);
			continue;
		}
		if (state !== 'closed') continue;
		const { exitCode } = await harper(dropArguments(inputs.app, pullRequest));
		if (exitCode === 0) {
			dropped++;
			await reportRemoved(context, pullRequest);
		} else {
			failed.push(name);
		}
	}
	if (failed.length > 0) throw new Error(`Could not drop ${failed.join(', ')}`);
	log.notice(`Dropped ${dropped} preview${dropped === 1 ? '' : 's'} of closed PRs.`);
	return { outcome: 'swept' };
}

export async function runPreview(context: PreviewContext, eventName: string, payload: unknown): Promise<ActionResult> {
	if (eventName === 'schedule' || eventName === 'workflow_dispatch') return sweepPreviews(context);
	if (eventName !== 'pull_request_target') {
		throw new Error(
			`preview: true runs on pull_request_target, schedule or workflow_dispatch, not ${eventName}. ` +
				'pull_request_target is what keeps PR code away from the preview identity.'
		);
	}
	const pullRequest = readPullRequestEvent(payload);
	if (pullRequest.headRepository !== context.repository) {
		context.log.notice(`Skipping PR #${pullRequest.number}: it comes from a fork.`);
		return { outcome: 'skipped' };
	}
	switch (pullRequest.action) {
		case 'opened':
		case 'reopened':
		case 'synchronize':
			return deployPreview(context, pullRequest);
		case 'closed':
			return dropClosedPreview(context, pullRequest.number);
		default:
			context.log.notice(`Nothing to do for the ${pullRequest.action} action.`);
			return { outcome: 'skipped' };
	}
}
