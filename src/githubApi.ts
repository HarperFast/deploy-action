const GET_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

export class GitHubApiError extends Error {
	status: number;

	constructor(method: string, url: string, status: number, body: string) {
		super(`${method} ${new URL(url).pathname} answered ${status}: ${body.slice(0, 300)}`);
		this.name = 'GitHubApiError';
		this.status = status;
	}
}

export interface PullRequest {
	state: string;
	head: { sha: string };
}

export interface IssueComment {
	id: number;
	body?: string;
	author_association?: string;
	user?: { login?: string };
}

export interface Deployment {
	id: number;
}

export interface DeploymentStatus {
	state: string;
}

export interface NewDeployment {
	ref: string;
	task: string;
	environment: string;
	description: string;
	payload: Record<string, unknown>;
}

export interface NewDeploymentStatus {
	state: string;
	description: string;
	log_url: string;
	environment_url?: string;
}

export interface GitHubApiOptions {
	apiUrl: string;
	token: string;
	repository: string;
	sleep?: (milliseconds: number) => Promise<void>;
}

function nextPage(link: string | null): string | undefined {
	return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
}

export class GitHubApi {
	#apiUrl: string;
	#token: string;
	#repository: string;
	#sleep: (milliseconds: number) => Promise<void>;

	constructor({
		apiUrl,
		token,
		repository,
		sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
	}: GitHubApiOptions) {
		this.#apiUrl = apiUrl.replace(/\/+$/, '');
		this.#token = token;
		this.#repository = repository;
		this.#sleep = sleep;
	}

	async #send(method: string, url: string, body?: unknown): Promise<Response> {
		const attempts = method === 'GET' ? GET_ATTEMPTS : 1;
		for (let attempt = 1; ; attempt++) {
			try {
				const response = await fetch(url, {
					method,
					headers: {
						'Accept': 'application/vnd.github+json',
						'Authorization': `Bearer ${this.#token}`,
						'Content-Type': 'application/json',
						'User-Agent': 'HarperFast/deploy-action',
						'X-GitHub-Api-Version': '2022-11-28',
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				if (response.ok) return response;
				const failure = new GitHubApiError(method, url, response.status, await response.text());
				if (response.status < 500 || attempt >= attempts) throw failure;
			} catch (error) {
				if (error instanceof GitHubApiError && error.status < 500) throw error;
				if (attempt >= attempts) throw error;
			}
			await this.#sleep(attempt * RETRY_DELAY_MS);
		}
	}

	async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await this.#send(method, `${this.#apiUrl}/repos/${this.#repository}${path}`, body);
		return response.json() as Promise<T>;
	}

	async *#pages<T>(path: string): AsyncGenerator<T> {
		let url: string | undefined = `${this.#apiUrl}/repos/${this.#repository}${path}`;
		while (url) {
			const response: Response = await this.#send('GET', url);
			yield* (await response.json()) as T[];
			url = nextPage(response.headers.get('link'));
		}
	}

	pullRequest(number: number): Promise<PullRequest> {
		return this.#json('GET', `/pulls/${number}`);
	}

	comments(pullRequest: number): AsyncGenerator<IssueComment> {
		return this.#pages(`/issues/${pullRequest}/comments?per_page=100`);
	}

	createComment(pullRequest: number, body: string): Promise<IssueComment> {
		return this.#json('POST', `/issues/${pullRequest}/comments`, { body });
	}

	updateComment(id: number, body: string): Promise<IssueComment> {
		return this.#json('PATCH', `/issues/comments/${id}`, { body });
	}

	/** Newest first. */
	deployments(task: string, environment: string): AsyncGenerator<Deployment> {
		const query = new URLSearchParams({ task, environment, per_page: '100' });
		return this.#pages(`/deployments?${query}`);
	}

	createDeployment(deployment: NewDeployment): Promise<Deployment> {
		return this.#json('POST', '/deployments', {
			...deployment,
			auto_merge: false,
			required_contexts: [],
			production_environment: false,
			transient_environment: true,
		});
	}

	async latestDeploymentStatus(id: number): Promise<DeploymentStatus | undefined> {
		const statuses = await this.#json<DeploymentStatus[]>('GET', `/deployments/${id}/statuses?per_page=1`);
		return statuses[0];
	}

	setDeploymentStatus(id: number, status: NewDeploymentStatus): Promise<DeploymentStatus> {
		// Every PR shares one environment, so GitHub's automatic retirement would take down the other PRs' previews.
		return this.#json('POST', `/deployments/${id}/statuses`, { ...status, auto_inactive: false });
	}
}
