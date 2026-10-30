import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { after, afterEach, before, suite, test } from 'node:test';
import { GitHubApi, GitHubApiError } from '../src/githubApi.ts';
import { FakeGitHub } from './support/fakeGitHub.ts';

suite('GitHubApi', () => {
	const fake = new FakeGitHub();
	const delays: number[] = [];
	let github: GitHubApi;

	before(async () => {
		await fake.start();
		github = new GitHubApi({
			apiUrl: `${fake.url}/`,
			token: 'token',
			repository: 'acme/shop',
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
	});
	after(() => fake.stop());
	afterEach(() => {
		delays.length = 0;
		fake.requests.length = 0;
		fake.comments.length = 0;
	});

	test('retries a read through a server error', async () => {
		fake.setPullRequest(1, { state: 'open', sha: 'abc' });
		fake.failNext(/GET \/pulls\/1/, 502);
		fake.failNext(/GET \/pulls\/1/, 503);
		strictEqual((await github.pullRequest(1)).state, 'open');
		deepStrictEqual(delays, [1000, 2000]);
	});

	test('gives up on a read after three attempts, with the status', async () => {
		for (let attempt = 0; attempt < 3; attempt++) fake.failNext(/GET \/pulls\/1/, 500);
		await rejects(github.pullRequest(1), (error: GitHubApiError) => error.status === 500);
	});

	test('does not retry a read the server refused', async () => {
		fake.failNext(/GET \/pulls\/1/, 403);
		await rejects(github.pullRequest(1), /answered 403/);
		strictEqual(fake.requests.length, 1);
	});

	test('does not repeat a write', async () => {
		fake.failNext(/POST \/issues\/1\/comments/, 502);
		await rejects(github.createComment(1, 'hello'), /answered 502/);
		strictEqual(fake.requests.length, 1);
	});

	test('follows pages through the Link header', async () => {
		fake.pageSize = 2;
		for (let index = 0; index < 5; index++) fake.addComment(1, `comment ${index}`, 'someone');
		const bodies: (string | undefined)[] = [];
		for await (const comment of github.comments(1)) bodies.push(comment.body);
		strictEqual(bodies.length, 5);
		strictEqual(fake.requests.length, 3);
		fake.pageSize = 100;
	});
});
