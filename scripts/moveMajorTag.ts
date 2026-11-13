import { workflowLog, type WorkflowLog } from '../src/workflowCommands.ts';

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export interface MoveMajorTagOptions {
	apiUrl: string;
	token: string;
	repository: string;
	tag: string;
	branch: string;
	requiredWorkflows: string[];
	log: WorkflowLog;
}

export type MoveOutcome = 'created' | 'moved' | 'unchanged' | 'kept';

interface Release {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
}

interface GitRef {
	object: { type: string; sha: string };
}

interface WorkflowRun {
	id: number;
	path: string;
	status: string;
	conclusion: string | null;
}

type Version = [number, number, number];

function parseVersion(tag: string): Version | undefined {
	const match = tag.match(RELEASE_TAG);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(left: Version, right: Version): number {
	return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function createClient({ apiUrl, token, repository }: MoveMajorTagOptions) {
	const base = `${apiUrl.replace(/\/+$/, '')}/repos/${repository}`;
	async function send(method: string, url: string, body?: unknown): Promise<Response> {
		const response = await fetch(url, {
			method,
			headers: {
				'Accept': 'application/vnd.github+json',
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
				'User-Agent': 'HarperFast/deploy-action release',
				'X-GitHub-Api-Version': '2022-11-28',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		if (response.ok || (method === 'GET' && response.status === 404)) return response;
		throw new Error(
			`${method} ${new URL(url).pathname} answered ${response.status}: ${(await response.text()).slice(0, 300)}`
		);
	}
	return {
		async json<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
			const response = await send(method, `${base}${path}`, body);
			return response.status === 404 ? undefined : ((await response.json()) as T);
		},
		async *pages<T>(path: string): AsyncGenerator<T> {
			let url: string | undefined = `${base}${path}`;
			while (url) {
				const response: Response = await send('GET', url);
				yield* (await response.json()) as T[];
				url = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
			}
		},
	};
}

type Client = ReturnType<typeof createClient>;

async function newestRelease(client: Client, tag: string, version: Version): Promise<string> {
	let newest = { tag, version };
	for await (const release of client.pages<Release>('/releases?per_page=100')) {
		const candidate = parseVersion(release.tag_name);
		if (release.draft || release.prerelease || candidate?.[0] !== version[0]) continue;
		if (compareVersions(candidate, newest.version) > 0) newest = { tag: release.tag_name, version: candidate };
	}
	return newest.tag;
}

async function commitOf(client: Client, tag: string): Promise<string> {
	let object = (await client.json<GitRef>('GET', `/git/ref/tags/${tag}`))?.object;
	while (object?.type === 'tag') object = (await client.json<GitRef>('GET', `/git/tags/${object.sha}`))?.object;
	if (object?.type !== 'commit') throw new Error(`${tag} does not point to a commit`);
	return object.sha;
}

async function assertOnBranch(client: Client, sha: string, branch: string, tag: string): Promise<void> {
	const comparison = await client.json<{ status: string }>('GET', `/compare/${sha}...${encodeURIComponent(branch)}`);
	if (comparison?.status !== 'ahead' && comparison?.status !== 'identical') {
		throw new Error(`${tag} (${sha.slice(0, 7)}) is not on ${branch}`);
	}
}

async function assertWorkflowsPassed(client: Client, sha: string, options: MoveMajorTagOptions): Promise<void> {
	const query = new URLSearchParams({ head_sha: sha, event: 'push', branch: options.branch, per_page: '100' });
	const runs =
		(await client.json<{ workflow_runs: WorkflowRun[] }>('GET', `/actions/runs?${query}`))?.workflow_runs ?? [];
	const unfinished = options.requiredWorkflows.filter((path) => {
		const latest = runs.filter((run) => run.path === path).sort((left, right) => right.id - left.id)[0];
		return latest?.conclusion !== 'success';
	});
	if (unfinished.length > 0) {
		throw new Error(
			`${options.tag} (${sha.slice(0, 7)}) has no passing push run of ${unfinished.join(', ')} on ${options.branch}; re-run this job once it passes`
		);
	}
}

/** Points `vMAJOR` at a newly published `vMAJOR.MINOR.PATCH` release, unless a newer release in that major already holds it. */
export async function moveMajorTag(options: MoveMajorTagOptions): Promise<MoveOutcome> {
	const { tag, log } = options;
	const version = parseVersion(tag);
	if (!version) throw new Error(`${tag} is not a vMAJOR.MINOR.PATCH release tag`);
	const major = `v${version[0]}`;
	const client = createClient(options);

	const newest = await newestRelease(client, tag, version);
	if (newest !== tag) {
		log.notice(`${major} stays with ${newest}, which is newer than ${tag}`);
		return 'kept';
	}
	const sha = await commitOf(client, tag);
	await assertOnBranch(client, sha, options.branch, tag);
	await assertWorkflowsPassed(client, sha, options);

	const current = (await client.json<GitRef>('GET', `/git/ref/tags/${major}`))?.object.sha;
	if (current === sha) {
		log.notice(`${major} already points to ${tag} (${sha.slice(0, 7)})`);
		return 'unchanged';
	}
	if (current === undefined) {
		await client.json('POST', '/git/refs', { ref: `refs/tags/${major}`, sha });
	} else {
		await client.json('PATCH', `/git/refs/tags/${major}`, { sha, force: true });
	}
	log.notice(`${major} now points to ${tag} (${sha.slice(0, 7)})`);
	return current === undefined ? 'created' : 'moved';
}

function requiredVariable(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

if (import.meta.main) {
	await moveMajorTag({
		apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
		token: requiredVariable('GITHUB_TOKEN'),
		repository: requiredVariable('GITHUB_REPOSITORY'),
		tag: requiredVariable('RELEASE_TAG'),
		branch: 'main',
		requiredWorkflows: ['.github/workflows/ci.yaml', '.github/workflows/e2e.yaml'],
		log: workflowLog,
	});
}
