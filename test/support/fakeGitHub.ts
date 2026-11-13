import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface PullRequestSnapshot {
	state: string;
	sha: string;
}

export interface FakeComment {
	id: number;
	issue: number;
	body: string;
	user: { login: string; type: string };
	author_association: string;
}

export interface FakeDeployment {
	id: number;
	ref: string;
	task: string;
	environment: string;
	statuses: Record<string, any>[];
	[field: string]: unknown;
}

interface FakeRelease {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
}

interface FakeGitObject {
	type: 'commit' | 'tag';
	sha: string;
}

export interface FakeWorkflowRun {
	id: number;
	path: string;
	head_sha: string;
	head_branch: string;
	event: string;
	status: string;
	conclusion: string | null;
}

const REPOSITORY_ROUTE = /^\/repos\/[^/]+\/[^/]+(\/.*)$/;

async function readJson(request: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

export class FakeGitHub {
	url = '';
	pageSize = 100;
	requests: string[] = [];
	comments: FakeComment[] = [];
	deployments: FakeDeployment[] = [];
	releases: FakeRelease[] = [];
	/** Keyed like `tags/v1`. */
	refs = new Map<string, FakeGitObject>();
	tagObjects = new Map<string, FakeGitObject>();
	/** Oldest first; the last commit is the branch's head. */
	branches = new Map<string, string[]>();
	workflowRuns: FakeWorkflowRun[] = [];
	refWrites: { method: string; ref: string; sha: string; force?: boolean }[] = [];
	#pullRequests = new Map<number, PullRequestSnapshot[]>();
	#failures: { pattern: RegExp; status: number }[] = [];
	#nextId = 1000;
	#server: Server = createServer((request, response) => {
		this.#handle(request, response).catch((error) => {
			response.writeHead(500);
			response.end(String(error));
		});
	});

	async start(): Promise<this> {
		await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
		this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
		return this;
	}

	async stop(): Promise<void> {
		await new Promise((resolve) => this.#server.close(resolve));
	}

	/** Each read of the PR takes the next snapshot, and the last one stays. */
	setPullRequest(number: number, ...snapshots: PullRequestSnapshot[]): void {
		this.#pullRequests.set(number, snapshots);
	}

	failNext(pattern: RegExp, status: number): void {
		this.#failures.push({ pattern, status });
	}

	addComment(issue: number, body: string, login: string, association = 'NONE'): FakeComment {
		const comment = {
			id: this.#nextId++,
			issue,
			body,
			user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
			author_association: association,
		};
		this.comments.push(comment);
		return comment;
	}

	#page(response: ServerResponse, url: URL, items: unknown[]): void {
		const size = Math.min(Number(url.searchParams.get('per_page') ?? 30), this.pageSize);
		const page = Number(url.searchParams.get('page') ?? 1);
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (page * size < items.length) {
			const next = new URL(url, this.url);
			next.searchParams.set('page', String(page + 1));
			headers.link = `<${next}>; rel="next"`;
		}
		response.writeHead(200, headers);
		response.end(JSON.stringify(items.slice((page - 1) * size, page * size)));
	}

	#json(response: ServerResponse, status: number, body: unknown): void {
		response.writeHead(status, { 'content-type': 'application/json' });
		response.end(JSON.stringify(body));
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? '/', this.url);
		const route = `${request.method} ${url.pathname.match(REPOSITORY_ROUTE)?.[1] ?? url.pathname}`;
		this.requests.push(route);
		const failure = this.#failures.findIndex(({ pattern }) => pattern.test(route));
		if (failure >= 0) {
			const [{ status }] = this.#failures.splice(failure, 1);
			return this.#json(response, status, { message: 'injected failure' });
		}
		const body = await readJson(request);
		let match: RegExpMatchArray | null;

		if ((match = route.match(/^GET \/pulls\/(\d+)$/))) {
			const snapshots = this.#pullRequests.get(Number(match[1]));
			if (!snapshots) return this.#json(response, 404, { message: 'Not Found' });
			const { state, sha } = snapshots.length > 1 ? snapshots.shift()! : snapshots[0];
			return this.#json(response, 200, { state, head: { sha } });
		}
		if ((match = route.match(/^GET \/issues\/(\d+)\/comments$/))) {
			const issue = Number(match[1]);
			return this.#page(
				response,
				url,
				this.comments.filter((comment) => comment.issue === issue)
			);
		}
		if ((match = route.match(/^POST \/issues\/(\d+)\/comments$/))) {
			const comment = this.addComment(Number(match[1]), body.body, 'github-actions[bot]');
			return this.#json(response, 201, comment);
		}
		if ((match = route.match(/^PATCH \/issues\/comments\/(\d+)$/))) {
			const comment = this.comments.find(({ id }) => id === Number(match![1]));
			if (!comment) return this.#json(response, 404, { message: 'Not Found' });
			comment.body = body.body;
			return this.#json(response, 200, comment);
		}
		if (route === 'GET /deployments') {
			const task = url.searchParams.get('task');
			const environment = url.searchParams.get('environment');
			const matching = this.deployments.filter(
				(deployment) => deployment.task === task && deployment.environment === environment
			);
			return this.#page(response, url, matching.toReversed());
		}
		if (route === 'POST /deployments') {
			const deployment = { ...body, id: this.#nextId++, statuses: [] };
			this.deployments.push(deployment);
			return this.#json(response, 201, deployment);
		}
		if ((match = route.match(/^(GET|POST) \/deployments\/(\d+)\/statuses$/))) {
			const deployment = this.deployments.find(({ id }) => id === Number(match![2]));
			if (!deployment) return this.#json(response, 404, { message: 'Not Found' });
			if (match[1] === 'GET') return this.#page(response, url, deployment.statuses.toReversed());
			deployment.statuses.push(body);
			return this.#json(response, 201, body);
		}
		if (route === 'GET /releases') return this.#page(response, url, this.releases);
		if ((match = route.match(/^GET \/git\/ref\/(.+)$/))) {
			const object = this.refs.get(match[1]);
			if (!object) return this.#json(response, 404, { message: 'Not Found' });
			return this.#json(response, 200, { ref: `refs/${match[1]}`, object });
		}
		if ((match = route.match(/^GET \/git\/tags\/([0-9a-f]+)$/))) {
			const object = this.tagObjects.get(match[1]);
			if (!object) return this.#json(response, 404, { message: 'Not Found' });
			return this.#json(response, 200, { sha: match[1], object });
		}
		if (route === 'POST /git/refs') {
			const ref = body.ref.replace(/^refs\//, '');
			if (this.refs.has(ref)) return this.#json(response, 422, { message: 'Reference already exists' });
			this.refs.set(ref, { type: 'commit', sha: body.sha });
			this.refWrites.push({ method: 'POST', ref, sha: body.sha });
			return this.#json(response, 201, { ref: body.ref, object: { type: 'commit', sha: body.sha } });
		}
		if ((match = route.match(/^PATCH \/git\/refs\/(.+)$/))) {
			if (!this.refs.has(match[1])) return this.#json(response, 422, { message: 'Reference does not exist' });
			this.refs.set(match[1], { type: 'commit', sha: body.sha });
			this.refWrites.push({ method: 'PATCH', ref: match[1], sha: body.sha, force: body.force });
			return this.#json(response, 200, { ref: `refs/${match[1]}`, object: { type: 'commit', sha: body.sha } });
		}
		if ((match = route.match(/^GET \/compare\/([0-9a-f]+)\.\.\.(.+)$/))) {
			const commits = this.branches.get(decodeURIComponent(match[2])) ?? [];
			const status = commits.at(-1) === match[1] ? 'identical' : commits.includes(match[1]) ? 'ahead' : 'diverged';
			return this.#json(response, 200, { status });
		}
		if (route === 'GET /actions/runs') {
			const workflow_runs = this.workflowRuns.filter(
				(run) =>
					run.head_sha === url.searchParams.get('head_sha') &&
					run.event === url.searchParams.get('event') &&
					run.head_branch === url.searchParams.get('branch')
			);
			return this.#json(response, 200, { total_count: workflow_runs.length, workflow_runs });
		}
		return this.#json(response, 404, { message: `No fake for ${route}` });
	}
}
