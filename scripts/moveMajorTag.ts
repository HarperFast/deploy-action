import { reportError, workflowLog, type WorkflowLog } from '../src/workflowCommands.ts';

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

type MoveOutcome = 'created' | 'moved' | 'unchanged';

interface Release {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
}

interface GitObject {
	type: string;
	sha: string;
}

interface WorkflowRun {
	id: number;
	path: string;
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
	async function send(method: string, url: string, body?: unknown, allowMissing = false): Promise<Response> {
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
		if (response.ok || (allowMissing && response.status === 404)) return response;
		throw new Error(
			`${method} ${new URL(url).pathname} answered ${response.status}: ${(await response.text()).slice(0, 300)}`
		);
	}
	return {
		async json<T>(method: string, path: string, body?: unknown): Promise<T> {
			return (await send(method, `${base}${path}`, body)).json() as Promise<T>;
		},
		async ref(name: string): Promise<GitObject | undefined> {
			const response = await send('GET', `${base}/git/ref/${name}`, undefined, true);
			return response.status === 404 ? undefined : ((await response.json()) as { object: GitObject }).object;
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

async function newestRelease(client: Client, tag: string, major: number) {
	let newest: { tag: string; version: Version } | undefined;
	let listed = false;
	for await (const release of client.pages<Release>('/releases?per_page=100')) {
		const candidate = parseVersion(release.tag_name);
		if (release.draft || release.prerelease || candidate?.[0] !== major) continue;
		listed ||= release.tag_name === tag;
		if (!newest || compareVersions(candidate, newest.version) > 0)
			newest = { tag: release.tag_name, version: candidate };
	}
	return { newest: newest?.tag, listed };
}

async function peel(client: Client, object: GitObject | undefined): Promise<string | undefined> {
	while (object?.type === 'tag')
		object = (await client.json<{ object: GitObject }>('GET', `/git/tags/${object.sha}`)).object;
	return object?.type === 'commit' ? object.sha : undefined;
}

async function assertOnBranch(client: Client, sha: string, branch: string, tag: string): Promise<void> {
	const { status } = await client.json<{ status: string }>('GET', `/compare/${sha}...${encodeURIComponent(branch)}`);
	if (status !== 'ahead' && status !== 'identical') throw new Error(`${tag} (${sha.slice(0, 7)}) is not on ${branch}`);
}

async function assertWorkflowsPassed(
	client: Client,
	sha: string,
	tag: string,
	options: MoveMajorTagOptions
): Promise<void> {
	const query = new URLSearchParams({ head_sha: sha, event: 'push', branch: options.branch, per_page: '100' });
	const { workflow_runs: runs } = await client.json<{ workflow_runs: WorkflowRun[] }>('GET', `/actions/runs?${query}`);
	const failing = options.requiredWorkflows.filter((path) => {
		const latest = runs.filter((run) => run.path === path).sort((left, right) => right.id - left.id)[0];
		return latest?.conclusion !== 'success';
	});
	if (failing.length > 0) {
		throw new Error(
			`${tag} (${sha.slice(0, 7)}) has no passing push run of ${failing.join(', ')} on ${options.branch}; re-run this job once it passes`
		);
	}
}

// A run follows the newest release, not the one that triggered it, because GitHub drops a pending run when the next one queues.
export async function moveMajorTag(options: MoveMajorTagOptions): Promise<MoveOutcome> {
	const { tag, log } = options;
	const version = parseVersion(tag);
	if (!version) throw new Error(`${tag} is not a vMAJOR.MINOR.PATCH release tag`);
	const major = `v${version[0]}`;
	const client = createClient(options);

	const { newest, listed } = await newestRelease(client, tag, version[0]);
	if (!listed) log.warning(`${tag} is no longer a published release, so ${major} leaves it out`);
	if (!newest) {
		log.notice(`${major} has no published release to follow`);
		return 'unchanged';
	}
	if (listed && newest !== tag) log.notice(`${major} follows ${newest}, which is newer than ${tag}`);
	const sha = await peel(client, await client.ref(`tags/${newest}`));
	if (!sha) throw new Error(`${newest} does not point to a commit`);
	await assertOnBranch(client, sha, options.branch, newest);
	await assertWorkflowsPassed(client, sha, newest, options);

	const current = await client.ref(`tags/${major}`);
	if ((await peel(client, current)) === sha) {
		log.notice(`${major} already points to ${newest} (${sha.slice(0, 7)})`);
		return 'unchanged';
	}
	if (current) {
		await client.json('PATCH', `/git/refs/tags/${major}`, { sha, force: true });
	} else {
		await client.json('POST', '/git/refs', { ref: `refs/tags/${major}`, sha });
	}
	log.notice(`${major} now points to ${newest} (${sha.slice(0, 7)})`);
	return current ? 'moved' : 'created';
}

function requiredVariable(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

if (import.meta.main) {
	try {
		await moveMajorTag({
			apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
			token: requiredVariable('GITHUB_TOKEN'),
			repository: requiredVariable('GITHUB_REPOSITORY'),
			tag: requiredVariable('RELEASE_TAG'),
			branch: 'main',
			requiredWorkflows: ['.github/workflows/ci.yaml', '.github/workflows/e2e.yaml'],
			log: workflowLog,
		});
	} catch (error) {
		reportError(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
