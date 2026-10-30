/**
 * GitHub's REST API is a local fake so that a PR can close mid-run, and git reads the "repository" from a local bare
 * one through `url.insteadOf`. Previews have no HTTP assertion: Harper's own ports refuse a preview's host by design
 * (host-manager reaches its worker), so the tests ask Harper what it runs instead.
 */
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, suite, test } from 'node:test';
import { promisify } from 'node:util';
import { FakeGitHub } from '../support/fakeGitHub.ts';

const ROOT = process.env.E2E_ROOT as string;
const TARGET = process.env.E2E_TARGET ?? 'http://127.0.0.1:9925';
const MAIN = resolve(import.meta.dirname, '../../src/main.ts');
const REPOSITORY = 'harper-e2e/shop';
const DOMAIN = 'app.e2e.test';
const ROLE = 'shop-ci-preview';
const PREVIEW_PASSWORD = 'e2e-Preview-Password1';
const POLICY_ID = 'e2e-preview';
const ADMIN = `Basic ${Buffer.from('e2e-admin:e2e-Admin-Password1').toString('base64')}`;
const HAS_IDENTITY = Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
const PREVIEW_OPERATIONS = [
	'deploy_component',
	'drop_component',
	'get_components',
	'get_deployment',
	'registration_info',
];

const { GITHUB_REPOSITORY_ID, GITHUB_WORKFLOW_REF, GITHUB_EVENT_NAME } = process.env;

async function operation(body: Record<string, unknown>): Promise<any> {
	const response = await fetch(`${TARGET}/`, {
		method: 'POST',
		headers: { 'Authorization': ADMIN, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const answer = await response.json();
	strictEqual(response.status, 200, `${body.operation}: ${JSON.stringify(answer)}`);
	return answer;
}

/** The token a run exchanges can do what the named trust policy allows, whatever the role allows beyond it. */
async function trustPolicyAllows(operations: string[]): Promise<void> {
	if (!HAS_IDENTITY) return;
	await operation({
		operation: 'add_oidc_trust',
		id: POLICY_ID,
		issuer: 'https://token.actions.githubusercontent.com',
		audience: `${TARGET}/`,
		user: ROLE,
		operations,
		claims: { repository_id: GITHUB_REPOSITORY_ID, workflow_ref: GITHUB_WORKFLOW_REF, event_name: GITHUB_EVENT_NAME },
	});
}

const component = async (name: string) =>
	(await operation({ operation: 'get_components' })).entries.find((entry: any) => entry.name === name);

async function dedicatedWorkers(name: string): Promise<number> {
	const { threads } = await operation({ operation: 'system_information', attributes: ['threads'] });
	return threads.filter((thread: any) => thread.application === name).length;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], {
		cwd,
		encoding: 'utf8',
	}).trim();
}

suite('preview lifecycle', () => {
	const fake = new FakeGitHub();
	const work = mkdtempSync(join(ROOT, 'lifecycle-'));
	const source = join(work, 'source');
	const bare = join(work, 'shop.git');
	let firstCommit: string;
	let secondCommit: string;

	function commitApp(content: string): string {
		writeFileSync(join(source, 'version.txt'), content);
		git(source, 'add', '.');
		git(source, 'commit', '--quiet', '-m', content);
		git(source, 'push', '--quiet', bare, 'HEAD:refs/heads/main');
		return git(source, 'rev-parse', 'HEAD');
	}

	function pullRequestEvent(action: string, number: number, sha: string, repository = REPOSITORY) {
		return {
			action,
			pull_request: { number, head: { ref: `e2e/pr-${number}`, sha, repo: { full_name: repository } } },
		};
	}

	async function runAction(
		eventName: string,
		payload: unknown,
		inputs: Record<string, string> = {}
	): Promise<Record<string, string>> {
		const eventPath = join(work, 'event.json');
		const outputPath = join(work, 'output');
		writeFileSync(eventPath, JSON.stringify(payload));
		writeFileSync(outputPath, '');
		await promisify(execFile)(process.execPath, [MAIN], {
			env: {
				...process.env,
				GITHUB_EVENT_NAME: eventName,
				GITHUB_EVENT_PATH: eventPath,
				GITHUB_OUTPUT: outputPath,
				GITHUB_REPOSITORY: REPOSITORY,
				GITHUB_API_URL: fake.url,
				GITHUB_RUN_ID: '1',
				INPUT_TARGET: TARGET,
				INPUT_APP: 'shop',
				INPUT_PREVIEW: 'true',
				INPUT_DOMAIN: DOMAIN,
				INPUT_GITHUB_TOKEN: 'fake',
				...inputs,
				...(HAS_IDENTITY
					? { HARPER_DEPLOY_ACTION_CLI: join(ROOT, 'cli/node_modules/.bin/harper') }
					: {
							HARPER_DEPLOY_ACTION_CLI: resolve(import.meta.dirname, 'password-cli.sh'),
							ACTIONS_ID_TOKEN_REQUEST_URL: 'https://unused.example.com/',
							ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'unused',
							E2E_USERNAME: ROLE,
							E2E_PASSWORD: PREVIEW_PASSWORD,
						}),
			},
		});
		const output: Record<string, string> = {};
		for (const [, name, value] of readFileSync(outputPath, 'utf8').matchAll(/^(\w+)<<(?:.*)\n(.*)\n/gm)) {
			output[name] = value;
		}
		return output;
	}

	before(async () => {
		await fake.start();
		mkdirSync(source);
		git(work, 'init', '--quiet', '--bare', bare);
		git(source, 'init', '--quiet', '--initial-branch=main');
		const app = resolve(import.meta.dirname, 'app');
		for (const file of readdirSync(app)) copyFileSync(join(app, file), join(source, file));
		firstCommit = commitApp('first');
		secondCommit = commitApp('second');
		writeFileSync(
			join(ROOT, 'gitconfig'),
			`[url "file://${bare}"]\n\tinsteadOf = https://github.com/${REPOSITORY}.git\n`
		);

		execFileSync(resolve(import.meta.dirname, 'enable-previews.sh'), {
			env: {
				...process.env,
				E2E_APP: 'shop',
				E2E_REPOSITORY: REPOSITORY,
				E2E_REPOSITORY_ID: '1',
				E2E_DOMAIN: DOMAIN,
				E2E_TARGET: TARGET,
			},
		});
		// It matches the same claims, and an exchange takes the first policy by id.
		if (HAS_IDENTITY) await operation({ operation: 'drop_oidc_trust', id: 'e2e-deploy' });
		await trustPolicyAllows(PREVIEW_OPERATIONS);
	});

	after(async () => {
		await fake.stop();
		rmSync(work, { recursive: true, force: true });
	});

	test('opened: deploys the commit by reference and reports it on the PR', async () => {
		fake.setPullRequest(7, { state: 'open', sha: firstCommit });
		const output = await runAction('pull_request_target', pullRequestEvent('opened', 7, firstCommit));
		strictEqual(output.outcome, 'deployed');
		strictEqual(output.url, `https://e2e-pr-7.${DOMAIN}/`);

		const preview = await component('shop-pr-7');
		strictEqual(preview.host, `e2e-pr-7.${DOMAIN}`);
		strictEqual(preview.preview.sha, firstCommit);
		strictEqual(preview.preview.pr, 7);
		strictEqual(preview.preview.repository, REPOSITORY);
		strictEqual(preview.package, `git+https://github.com/${REPOSITORY}.git#${firstCommit}`);
		strictEqual(await dedicatedWorkers('shop-pr-7'), 1);

		strictEqual(fake.comments.length, 1);
		match(fake.comments[0].body, /e2e-pr-7\.app\.e2e\.test/);
		strictEqual(fake.deployments[0].statuses.at(-1)?.environment_url, output.url);
	});

	test('synchronize: moves the preview to the new commit, in place', async () => {
		fake.setPullRequest(7, { state: 'open', sha: secondCommit });
		const output = await runAction('pull_request_target', pullRequestEvent('synchronize', 7, secondCommit));
		strictEqual(output.outcome, 'deployed');
		strictEqual((await component('shop-pr-7')).preview.sha, secondCommit);
		strictEqual(fake.comments.length, 1);
		strictEqual(fake.deployments[0].statuses.at(-1)?.state, 'inactive');
		strictEqual(fake.deployments[1].statuses.at(-1)?.state, 'success');
	});

	test('a fork never reaches the cluster', async () => {
		const fork = pullRequestEvent('opened', 8, firstCommit, 'stranger/shop');
		strictEqual((await runAction('pull_request_target', fork)).outcome, 'skipped');
		strictEqual(await component('shop-pr-8'), undefined);
	});

	test('closed, then reopened before the job ran: keeps the preview', async () => {
		fake.setPullRequest(7, { state: 'open', sha: secondCommit });
		const output = await runAction('pull_request_target', pullRequestEvent('closed', 7, secondCommit));
		strictEqual(output.outcome, 'kept');
		ok(await component('shop-pr-7'));
	});

	test('closed: the drop-only policy removes the preview and its worker', async () => {
		await trustPolicyAllows(['drop_component']);
		fake.setPullRequest(7, { state: 'closed', sha: secondCommit });
		const output = await runAction('pull_request_target', pullRequestEvent('closed', 7, secondCommit));
		strictEqual(output.outcome, 'dropped');
		strictEqual(await component('shop-pr-7'), undefined);
		strictEqual(await dedicatedWorkers('shop-pr-7'), 0);
		strictEqual(fake.deployments[1].statuses.at(-1)?.state, 'inactive');
		match(fake.comments[0].body, /preview removed/);
	});

	test('closed while deploying: drops what it deployed', async () => {
		await trustPolicyAllows(PREVIEW_OPERATIONS);
		fake.setPullRequest(
			9,
			{ state: 'open', sha: firstCommit },
			{ state: 'closed', sha: firstCommit },
			{ state: 'closed', sha: firstCommit }
		);
		const output = await runAction('pull_request_target', pullRequestEvent('opened', 9, firstCommit));
		strictEqual(output.outcome, 'dropped');
		strictEqual(await component('shop-pr-9'), undefined);
	});

	test('schedule: the sweep policy drops the previews of closed PRs only', async () => {
		fake.setPullRequest(10, { state: 'open', sha: firstCommit });
		fake.setPullRequest(11, { state: 'open', sha: firstCommit });
		await runAction('pull_request_target', pullRequestEvent('opened', 10, firstCommit));
		await runAction('pull_request_target', pullRequestEvent('opened', 11, firstCommit));

		await trustPolicyAllows(['get_components', 'drop_component']);
		fake.setPullRequest(10, { state: 'closed', sha: firstCommit });
		strictEqual((await runAction('schedule', {})).outcome, 'swept');
		strictEqual(await component('shop-pr-10'), undefined);
		ok(await component('shop-pr-11'));
	});

	test('a directory deployed as a preview records the PR commit', async () => {
		await trustPolicyAllows(PREVIEW_OPERATIONS);
		fake.setPullRequest(12, { state: 'open', sha: firstCommit });
		const output = await runAction('pull_request_target', pullRequestEvent('opened', 12, firstCommit), {
			INPUT_BY_REF: 'false',
			INPUT_PATH: resolve(import.meta.dirname, 'app'),
		});
		strictEqual(output.outcome, 'deployed');
		const preview = await component('shop-pr-12');
		strictEqual(preview.preview.sha, firstCommit);
		strictEqual(preview.package, undefined);
	});

	test('a saved admin login does not outrank the identity token', async () => {
		const { operation_token } = await operation({
			operation: 'create_authentication_tokens',
			username: 'e2e-admin',
			password: 'e2e-Admin-Password1',
		});
		const home = join(work, 'home');
		mkdirSync(join(home, '.harperdb'), { recursive: true });
		writeFileSync(
			join(home, '.harperdb', 'credentials.json'),
			JSON.stringify({ targets: { [`${TARGET}/`]: { operation_token } }, last_target: `${TARGET}/` })
		);
		const identity = createServer((_request, response) => {
			response.writeHead(500);
			response.end();
		});
		await new Promise<void>((done) => identity.listen(0, '127.0.0.1', done));
		const outputPath = join(work, 'output');
		try {
			await promisify(execFile)(process.execPath, [MAIN], {
				env: {
					...process.env,
					HOME: home,
					GITHUB_OUTPUT: outputPath,
					INPUT_TARGET: TARGET,
					INPUT_APP: 'e2e-saved-login',
					INPUT_PATH: resolve(import.meta.dirname, 'app'),
					INPUT_RESTART: 'true',
					HARPER_DEPLOY_ACTION_CLI: join(ROOT, 'cli/node_modules/.bin/harper'),
					ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${(identity.address() as AddressInfo).port}/`,
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'unused',
				},
			});
			ok(false, 'the deploy authenticated without the identity token');
		} catch (error: any) {
			match(error.stderr, /Could not obtain a GitHub Actions identity token/);
		} finally {
			identity.close();
		}
		strictEqual(await component('e2e-saved-login'), undefined);
	});

	test('the normal deploy through action.yml, on the runner, took effect', { skip: !HAS_IDENTITY }, async () => {
		deepStrictEqual((await component('e2e-deploy'))?.name, 'e2e-deploy');
	});
});
