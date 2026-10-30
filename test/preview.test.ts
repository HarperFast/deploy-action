import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { after, afterEach, before, beforeEach, suite, test } from 'node:test';
import { GitHubApi } from '../src/githubApi.ts';
import type { HarperOptions, HarperResult } from '../src/harperCli.ts';
import { readInputs } from '../src/inputs.ts';
import { runPreview, type PreviewContext } from '../src/preview.ts';
import { FakeGitHub } from './support/fakeGitHub.ts';

const REPOSITORY = 'acme/shop';
const SHA = 'a'.repeat(40);
const NEWER_SHA = 'b'.repeat(40);
const URL = 'https://fix-cart.app.cluster.example.com/';
const RUN_URL = 'https://github.com/acme/shop/actions/runs/1';
const DEPLOY_OUTPUT = `message: done\nPreview: ${URL}\n`;
const MARKER = '<!-- harper-deploy-action:preview:shop -->';

function pullRequestEvent(action: string, overrides: Record<string, unknown> = {}) {
	return {
		action,
		pull_request: {
			number: 12,
			head: { ref: 'fix/cart', sha: SHA, repo: { full_name: REPOSITORY } },
			...overrides,
		},
	};
}

type HarperScript = (args: string[]) => Partial<HarperResult>;

suite('runPreview', () => {
	const fake = new FakeGitHub();
	let calls: { args: string[]; options?: HarperOptions }[];
	let notices: string[];
	let warnings: string[];
	let delays: number[];

	before(() => fake.start());
	after(() => fake.stop());
	beforeEach(() => {
		calls = [];
		notices = [];
		warnings = [];
		delays = [];
		fake.comments.length = 0;
		fake.deployments.length = 0;
		fake.requests.length = 0;
		fake.setPullRequest(12, { state: 'open', sha: SHA });
	});
	afterEach(() => {
		fake.pageSize = 100;
	});

	function context(script: HarperScript = () => ({ stdout: DEPLOY_OUTPUT }), env = {}): PreviewContext {
		const sleep = async (milliseconds: number) => {
			delays.push(milliseconds);
		};
		return {
			inputs: readInputs({
				INPUT_TARGET: 'https://cluster.example.com:9925/',
				INPUT_APP: 'shop',
				INPUT_PREVIEW: 'true',
				INPUT_GITHUB_TOKEN: 'token',
				...env,
			}),
			harper: async (args, options) => {
				calls.push({ args, options });
				return { exitCode: 0, stdout: '', ...script(args) };
			},
			github: new GitHubApi({ apiUrl: fake.url, token: 'token', repository: REPOSITORY, sleep }),
			log: {
				notice: (message) => notices.push(message),
				warning: (message) => warnings.push(message),
			},
			repository: REPOSITORY,
			runUrl: RUN_URL,
			sleep,
		};
	}

	const statesOf = (index = 0) => fake.deployments[index].statuses.map((status) => status.state);
	const dropsIn = () => calls.filter(({ args }) => args[1] === 'drop').length;

	suite('deploying', () => {
		for (const action of ['opened', 'reopened', 'synchronize']) {
			test(`${action} deploys the head commit by reference`, async () => {
				const result = await runPreview(context(), 'pull_request_target', pullRequestEvent(action));
				deepStrictEqual(result, { outcome: 'deployed', url: URL });
				deepStrictEqual(calls[0].args, [
					'preview',
					'deploy',
					'app=shop',
					'pr=12',
					'branch=fix/cart',
					'by_ref=true',
					`ref=${SHA}`,
				]);
				strictEqual(calls[0].options?.cwd, undefined);
			});
		}

		test('posts one comment and one Deployment with the URL', async () => {
			await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			strictEqual(fake.comments.length, 1);
			ok(fake.comments[0].body.startsWith(MARKER));
			match(fake.comments[0].body, /fix-cart\.app\.cluster\.example\.com/);
			match(fake.comments[0].body, new RegExp(`\`${SHA.slice(0, 7)}\``));

			strictEqual(fake.deployments.length, 1);
			const [deployment] = fake.deployments;
			strictEqual(deployment.ref, SHA);
			strictEqual(deployment.environment, 'shop-preview');
			strictEqual(deployment.task, 'preview:shop:pr-12');
			strictEqual(deployment.auto_merge, false);
			deepStrictEqual(deployment.required_contexts, []);
			strictEqual(deployment.transient_environment, true);
			strictEqual(deployment.production_environment, false);
			deepStrictEqual(statesOf(), ['in_progress', 'success']);
			const success = deployment.statuses[1];
			strictEqual(success.environment_url, URL);
			strictEqual(success.log_url, RUN_URL);
			strictEqual(success.auto_inactive, false);
		});

		test('a new push updates the comment in place and retires the earlier Deployment', async () => {
			await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			fake.setPullRequest(12, { state: 'open', sha: NEWER_SHA });
			const synchronize = pullRequestEvent('synchronize', {
				head: { ref: 'fix/cart', sha: NEWER_SHA, repo: { full_name: REPOSITORY } },
			});
			await runPreview(context(), 'pull_request_target', synchronize);

			strictEqual(fake.comments.length, 1);
			match(fake.comments[0].body, new RegExp(`\`${NEWER_SHA.slice(0, 7)}\``));
			deepStrictEqual(statesOf(0), ['in_progress', 'success', 'inactive']);
			deepStrictEqual(statesOf(1), ['in_progress', 'success']);
		});

		test("leaves another PR's Deployment alone", async () => {
			await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			fake.setPullRequest(13, { state: 'open', sha: NEWER_SHA });
			const other = pullRequestEvent('opened', {
				number: 13,
				head: { ref: 'other', sha: NEWER_SHA, repo: { full_name: REPOSITORY } },
			});
			await runPreview(context(), 'pull_request_target', other);
			deepStrictEqual(statesOf(0), ['in_progress', 'success']);
			strictEqual(fake.comments.length, 2);
		});

		test('finds its comment past the first page', async () => {
			fake.pageSize = 2;
			for (let index = 0; index < 5; index++) fake.addComment(12, `chatter ${index}`, 'someone', 'MEMBER');
			fake.addComment(12, `${MARKER}\nold`, 'github-actions[bot]');
			await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			strictEqual(fake.comments.length, 6);
			match(fake.comments[5].body, /fix-cart/);
		});

		test("does not adopt a stranger's comment that carries the marker", async () => {
			const planted = fake.addComment(12, `${MARKER}\nplanted`, 'stranger');
			await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			strictEqual(planted.body, `${MARKER}\nplanted`);
			strictEqual(fake.comments.length, 2);
		});

		test('two applications in one repository keep apart', async () => {
			await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			await runPreview(context(undefined, { INPUT_APP: 'admin' }), 'pull_request_target', pullRequestEvent('opened'));
			strictEqual(fake.comments.length, 2);
			strictEqual(fake.deployments[1].environment, 'admin-preview');
			deepStrictEqual(statesOf(0), ['in_progress', 'success']);
		});

		test('passes every preview option', async () => {
			await runPreview(
				context(undefined, {
					INPUT_DOMAIN: 'preview.example.com',
					INPUT_LABEL: 'shop',
					INPUT_TTL: '3',
					INPUT_CREDENTIAL: 'true',
					INPUT_BRANCHED_DATABASES: 'false',
					INPUT_ARGS: 'package=npm:shop@1.2.3',
				}),
				'pull_request_target',
				pullRequestEvent('opened')
			);
			deepStrictEqual(calls[0].args.slice(5), [
				'by_ref=true',
				`ref=${SHA}`,
				'domain=preview.example.com',
				'label=shop',
				'ttl=3',
				'credential=true',
				'branchedDatabases=false',
				'package=npm:shop@1.2.3',
			]);
		});

		test('by_ref false deploys the path as a payload, still recording the commit', async () => {
			await runPreview(
				context(undefined, { INPUT_BY_REF: 'false', INPUT_PATH: 'dist' }),
				'pull_request_target',
				pullRequestEvent('opened')
			);
			deepStrictEqual(calls[0].args.slice(5), [`sha=${SHA}`]);
			strictEqual(calls[0].options?.cwd, resolve('dist'));
		});

		test('comment and github_deployment turn those surfaces off', async () => {
			await runPreview(
				context(undefined, { INPUT_COMMENT: 'false', INPUT_GITHUB_DEPLOYMENT: 'false' }),
				'pull_request_target',
				pullRequestEvent('opened')
			);
			strictEqual(calls.length, 1);
			strictEqual(fake.comments.length, 0);
			strictEqual(fake.deployments.length, 0);
		});
	});

	suite('deploy guards', () => {
		test('skips a commit that is no longer the head of the PR', async () => {
			fake.setPullRequest(12, { state: 'open', sha: NEWER_SHA });
			const result = await runPreview(context(), 'pull_request_target', pullRequestEvent('synchronize'));
			strictEqual(result.outcome, 'skipped');
			strictEqual(calls.length, 0);
			strictEqual(fake.deployments.length, 0);
		});

		test('skips a PR that closed before the job started', async () => {
			fake.setPullRequest(12, { state: 'closed', sha: SHA });
			const result = await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			strictEqual(result.outcome, 'skipped');
			strictEqual(calls.length, 0);
		});

		test('does not deploy when the open check itself fails', async () => {
			for (let attempt = 0; attempt < 3; attempt++) fake.failNext(/GET \/pulls\/12/, 500);
			await rejects(runPreview(context(), 'pull_request_target', pullRequestEvent('opened')), /answered 500/);
			strictEqual(calls.length, 0);
		});

		test('drops what it deployed when the PR closed meanwhile', async () => {
			fake.setPullRequest(12, { state: 'open', sha: SHA }, { state: 'closed', sha: SHA });
			const result = await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			strictEqual(result.outcome, 'dropped');
			deepStrictEqual(
				calls.map(({ args }) => args[1]),
				['deploy', 'drop']
			);
			deepStrictEqual(statesOf(), ['in_progress', 'inactive']);
			strictEqual(fake.comments.length, 0);
		});

		test('a failed deploy of a PR that closed meanwhile is still dropped, and still fails', async () => {
			fake.setPullRequest(12, { state: 'open', sha: SHA }, { state: 'closed', sha: SHA });
			const script: HarperScript = (args) => ({ exitCode: args[1] === 'deploy' ? 1 : 0 });
			await rejects(
				runPreview(context(script), 'pull_request_target', pullRequestEvent('opened')),
				/harper preview deploy exited with 1/
			);
			strictEqual(dropsIn(), 1);
		});

		test('keeps what it deployed when the PR closed and reopened meanwhile', async () => {
			fake.setPullRequest(12, { state: 'open', sha: SHA }, { state: 'closed', sha: SHA }, { state: 'open', sha: SHA });
			const result = await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			strictEqual(result.outcome, 'deployed');
			strictEqual(dropsIn(), 0);
		});

		test('a failed check after deploying leaves the preview and warns', async () => {
			fake.setPullRequest(12, { state: 'open', sha: SHA });
			const harper = context();
			const original = harper.harper;
			harper.harper = async (args, options) => {
				for (let attempt = 0; attempt < 3; attempt++) fake.failNext(/GET \/pulls\/12/, 500);
				return original(args, options);
			};
			const result = await runPreview(harper, 'pull_request_target', pullRequestEvent('opened'));
			strictEqual(result.outcome, 'deployed');
			match(warnings[0], /Could not check PR #12 after deploying/);
		});

		test('a failed deploy reports on the Deployment and the comment, and fails the run', async () => {
			await rejects(
				runPreview(
					context(() => ({ exitCode: 1 })),
					'pull_request_target',
					pullRequestEvent('opened')
				),
				/harper preview deploy exited with 1/
			);
			deepStrictEqual(statesOf(), ['in_progress', 'failure']);
			match(fake.comments[0].body, /preview failed/);
			match(fake.comments[0].body, new RegExp(RUN_URL));
		});

		test('a GitHub surface that fails does not fail the deploy', async () => {
			fake.failNext(/POST \/deployments$/, 403);
			fake.failNext(/GET \/issues\/12\/comments/, 403);
			const result = await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			deepStrictEqual(result, { outcome: 'deployed', url: URL });
			strictEqual(warnings.length, 2);
			match(warnings[0], /Could not create the GitHub Deployment/);
			match(warnings[1], /Could not update the PR comment/);
		});

		test('warns when the CLI prints no URL', async () => {
			const result = await runPreview(
				context(() => ({ stdout: 'message: done\n' })),
				'pull_request_target',
				pullRequestEvent('opened')
			);
			strictEqual(result.url, undefined);
			match(warnings[0], /no preview URL/);
		});

		test('never deploys a fork', async () => {
			for (const action of ['opened', 'synchronize', 'closed']) {
				const fork = pullRequestEvent(action, {
					head: { ref: 'main', sha: SHA, repo: { full_name: 'stranger/shop' } },
				});
				const result = await runPreview(context(), 'pull_request_target', fork);
				strictEqual(result.outcome, 'skipped');
			}
			strictEqual(calls.length, 0);
			strictEqual(fake.requests.length, 0);
		});

		test('treats a deleted head repository as a fork', async () => {
			const deleted = pullRequestEvent('opened', { head: { ref: 'main', sha: SHA, repo: null } });
			strictEqual((await runPreview(context(), 'pull_request_target', deleted)).outcome, 'skipped');
			strictEqual(calls.length, 0);
		});

		test('ignores an action it has no part in', async () => {
			const result = await runPreview(context(), 'pull_request_target', pullRequestEvent('labeled'));
			strictEqual(result.outcome, 'skipped');
			strictEqual(calls.length, 0);
		});

		test('refuses pull_request, whose runs execute the PR’s own workflow', async () => {
			await rejects(
				runPreview(context(), 'pull_request', pullRequestEvent('opened')),
				/preview: true runs on pull_request_target/
			);
			strictEqual(calls.length, 0);
		});
	});

	suite('closing', () => {
		beforeEach(() => fake.setPullRequest(12, { state: 'closed', sha: SHA }));

		test('drops the preview, retires its Deployment and says so in the comment', async () => {
			fake.setPullRequest(12, { state: 'open', sha: SHA });
			await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			fake.setPullRequest(12, { state: 'closed', sha: SHA });
			calls.length = 0;

			const result = await runPreview(context(), 'pull_request_target', pullRequestEvent('closed'));
			strictEqual(result.outcome, 'dropped');
			deepStrictEqual(calls[0].args, ['preview', 'drop', 'app=shop', 'pr=12']);
			deepStrictEqual(statesOf(), ['in_progress', 'success', 'inactive']);
			strictEqual(fake.comments.length, 1);
			match(fake.comments[0].body, /preview removed/);
		});

		test('adds no comment to a PR that never had one', async () => {
			await runPreview(context(), 'pull_request_target', pullRequestEvent('closed'));
			strictEqual(fake.comments.length, 0);
		});

		test('a reopened PR keeps its preview', async () => {
			fake.setPullRequest(12, { state: 'open', sha: SHA });
			const result = await runPreview(context(), 'pull_request_target', pullRequestEvent('closed'));
			strictEqual(result.outcome, 'kept');
			strictEqual(calls.length, 0);
		});

		test('retries while a deploy still holds the preview', async () => {
			let attempts = 0;
			const script: HarperScript = () => ({ exitCode: ++attempts < 3 ? 1 : 0 });
			const result = await runPreview(context(script), 'pull_request_target', pullRequestEvent('closed'));
			strictEqual(result.outcome, 'dropped');
			strictEqual(attempts, 3);
			deepStrictEqual(delays, [30_000, 30_000]);
		});

		test('stops retrying if the PR reopens', async () => {
			fake.setPullRequest(12, { state: 'closed', sha: SHA }, { state: 'open', sha: SHA });
			const result = await runPreview(
				context(() => ({ exitCode: 1 })),
				'pull_request_target',
				pullRequestEvent('closed')
			);
			strictEqual(result.outcome, 'kept');
			strictEqual(calls.length, 1);
		});

		test('fails after five attempts', async () => {
			await rejects(
				runPreview(
					context(() => ({ exitCode: 1 })),
					'pull_request_target',
					pullRequestEvent('closed')
				),
				/not dropped after 5 attempts/
			);
			strictEqual(calls.length, 5);
			strictEqual(delays.length, 4);
		});

		test('retries through a GitHub failure rather than dropping blind', async () => {
			for (let attempt = 0; attempt < 3; attempt++) fake.failNext(/GET \/pulls\/12/, 500);
			const result = await runPreview(context(), 'pull_request_target', pullRequestEvent('closed'));
			strictEqual(result.outcome, 'dropped');
			strictEqual(calls.length, 1);
			match(warnings[0], /Could not read PR #12/);
		});
	});

	suite('sweeping', () => {
		function entry(pr: number, overrides: Record<string, unknown> = {}) {
			return {
				name: `shop-pr-${pr}`,
				preview: { app: 'shop', pr, repository: REPOSITORY },
				...overrides,
			};
		}

		function listing(...entries: unknown[]): HarperScript {
			return (args) => (args[0] === 'get_components' ? { stdout: JSON.stringify({ entries }) } : {});
		}

		for (const eventName of ['schedule', 'workflow_dispatch']) {
			test(`${eventName} drops the previews of closed PRs and keeps the open ones`, async () => {
				fake.setPullRequest(21, { state: 'closed', sha: SHA });
				fake.setPullRequest(22, { state: 'open', sha: SHA });
				const result = await runPreview(context(listing(entry(21), entry(22))), eventName, {});
				strictEqual(result.outcome, 'swept');
				deepStrictEqual(calls[0], { args: ['get_components', 'json=true'], options: { quiet: true } });
				deepStrictEqual(
					calls.slice(1).map(({ args }) => args),
					[['preview', 'drop', 'app=shop', 'pr=21']]
				);
				match(notices[0], /Dropped 1 preview of closed PRs/);
			});
		}

		test('retires the Deployment and updates the comment of a swept preview', async () => {
			fake.setPullRequest(12, { state: 'open', sha: SHA });
			await runPreview(context(), 'pull_request_target', pullRequestEvent('opened'));
			fake.setPullRequest(12, { state: 'closed', sha: SHA });
			await runPreview(context(listing(entry(12))), 'schedule', {});
			deepStrictEqual(statesOf(), ['in_progress', 'success', 'inactive']);
			match(fake.comments[0].body, /preview removed/);
		});

		test("leaves other applications', other repositories' and misnamed components alone", async () => {
			fake.setPullRequest(31, { state: 'closed', sha: SHA });
			const script = listing(
				{ name: 'shop' },
				entry(31, { preview: { app: 'docs', pr: 31, repository: REPOSITORY } }),
				entry(31, { preview: { app: 'shop', pr: 31, repository: 'acme/other' } }),
				entry(31, { name: 'shop-pr-32' })
			);
			await runPreview(context(script), 'schedule', {});
			strictEqual(dropsIn(), 0);
		});

		test('leaves a preview to expire when its PR cannot be found', async () => {
			const result = await runPreview(context(listing(entry(404))), 'schedule', {});
			strictEqual(result.outcome, 'swept');
			strictEqual(dropsIn(), 0);
			match(warnings[0], /left to expire/);
		});

		test('stops rather than guessing when GitHub cannot say', async () => {
			fake.setPullRequest(41, { state: 'closed', sha: SHA });
			fake.failNext(/GET \/pulls\/41/, 403);
			await rejects(runPreview(context(listing(entry(41))), 'schedule', {}), /answered 403/);
			strictEqual(dropsIn(), 0);
		});

		test('a drop that fails does not stop the others, and fails the run', async () => {
			fake.setPullRequest(51, { state: 'closed', sha: SHA });
			fake.setPullRequest(52, { state: 'closed', sha: SHA });
			const listed = listing(entry(51), entry(52));
			const script: HarperScript = (args) => ({
				...listed(args),
				...(args.at(-1) === 'pr=51' && { exitCode: 1 }),
			});
			await rejects(runPreview(context(script), 'schedule', {}), /Could not drop shop-pr-51/);
			strictEqual(dropsIn(), 2);
		});

		test('fails when the cluster cannot list', async () => {
			await rejects(
				runPreview(
					context(() => ({ exitCode: 1 })),
					'schedule',
					{}
				),
				/harper get_components exited with 1/
			);
		});
	});
});
