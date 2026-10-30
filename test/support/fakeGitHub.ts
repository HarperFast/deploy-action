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
	user: { login: string };
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

const REPOSITORY_ROUTE = /^\/repos\/[^/]+\/[^/]+(\/.*)$/;

async function readJson(request: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

/** GitHub's REST API, as far as the action uses it, over real HTTP. */
export class FakeGitHub {
	url = '';
	pageSize = 100;
	requests: string[] = [];
	comments: FakeComment[] = [];
	deployments: FakeDeployment[] = [];
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
			user: { login },
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
		return this.#json(response, 404, { message: `No fake for ${route}` });
	}
}
