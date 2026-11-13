import { deepStrictEqual, match, rejects, strictEqual } from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, suite, test } from 'node:test';
import { moveMajorTag, type MoveMajorTagOptions } from '../scripts/moveMajorTag.ts';
import { FakeGitHub, type FakeWorkflowRun } from './support/fakeGitHub.ts';

const OLD_SHA = 'a'.repeat(40);
const SHA = 'b'.repeat(40);
const TAG_OBJECT = 'c'.repeat(40);
const BACKPORT_SHA = 'd'.repeat(40);
const CI = '.github/workflows/ci.yaml';
const E2E = '.github/workflows/e2e.yaml';
const SCRIPT = fileURLToPath(new URL('../scripts/moveMajorTag.ts', import.meta.url));

function runStep(env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = execFile(process.execPath, [SCRIPT], { env }, (_error, stdout, stderr) =>
			resolve({ status: child.exitCode, stdout, stderr })
		);
	});
}

suite('moveMajorTag', () => {
	const fake = new FakeGitHub();
	let notices: string[];
	let warnings: string[];
	let nextRun: number;

	before(() => fake.start());
	after(() => fake.stop());
	beforeEach(() => {
		notices = [];
		warnings = [];
		nextRun = 1;
		fake.pageSize = 100;
		fake.releases = [];
		fake.unlistedReleases = [];
		fake.refs.clear();
		fake.tagObjects.clear();
		fake.branches = new Map([['main', [OLD_SHA, SHA]]]);
		fake.workflowRuns = [];
		fake.refWrites = [];
		fake.requests.length = 0;
	});

	function publish(tag: string, sha = SHA, flags: { draft?: boolean; prerelease?: boolean } = {}): void {
		fake.releases.unshift({ tag_name: tag, draft: false, prerelease: false, ...flags });
		fake.refs.set(`tags/${tag}`, { type: 'commit', sha });
	}

	function run(path: string, conclusion: string | null, overrides: Partial<FakeWorkflowRun> = {}): void {
		fake.workflowRuns.push({
			id: nextRun++,
			path,
			head_sha: SHA,
			head_branch: 'main',
			event: 'push',
			status: conclusion ? 'completed' : 'in_progress',
			conclusion,
			...overrides,
		});
	}

	function passCi(sha = SHA): void {
		run(CI, 'success', { head_sha: sha });
		run(E2E, 'success', { head_sha: sha });
	}

	function options(tag: string): MoveMajorTagOptions {
		return {
			apiUrl: fake.url,
			token: 'token',
			repository: 'HarperFast/deploy-action',
			tag,
			branch: 'main',
			requiredWorkflows: [CI, E2E],
			log: { notice: (message) => notices.push(message), warning: (message) => warnings.push(message) },
		};
	}

	test('creates the major tag for a first release', async () => {
		publish('v1.0.0');
		passCi();
		strictEqual(await moveMajorTag(options('v1.0.0')), 'created');
		deepStrictEqual(fake.refWrites, [{ method: 'POST', ref: 'tags/v1', sha: SHA }]);
		deepStrictEqual(notices, ['v1 now points to v1.0.0 (bbbbbbb)']);
	});

	test('force-moves the major tag to a newer release', async () => {
		publish('v1.0.0', OLD_SHA);
		fake.refs.set('tags/v1', { type: 'commit', sha: OLD_SHA });
		publish('v1.0.1');
		passCi();
		strictEqual(await moveMajorTag(options('v1.0.1')), 'moved');
		deepStrictEqual(fake.refWrites, [{ method: 'PATCH', ref: 'tags/v1', sha: SHA, force: true }]);
	});

	test('accepts a release behind the tip of main', async () => {
		fake.branches.set('main', [OLD_SHA, SHA, BACKPORT_SHA]);
		publish('v1.0.0');
		passCi();
		strictEqual(await moveMajorTag(options('v1.0.0')), 'created');
	});

	test('leaves a major tag that already points at the release, even through an annotated tag', async () => {
		publish('v1.0.1');
		fake.refs.set('tags/v1', { type: 'tag', sha: TAG_OBJECT });
		fake.tagObjects.set(TAG_OBJECT, { type: 'commit', sha: SHA });
		passCi();
		strictEqual(await moveMajorTag(options('v1.0.1')), 'unchanged');
		deepStrictEqual(fake.refWrites, []);
	});

	test('keeps the major tag on a newer release when an older line is patched', async () => {
		publish('v1.1.0', OLD_SHA);
		fake.refs.set('tags/v1', { type: 'commit', sha: OLD_SHA });
		passCi(OLD_SHA);
		publish('v1.0.2', BACKPORT_SHA);
		strictEqual(await moveMajorTag(options('v1.0.2')), 'unchanged');
		deepStrictEqual(fake.refWrites, []);
		deepStrictEqual(notices, [
			'v1 follows v1.1.0, which is newer than v1.0.2',
			'v1 already points to v1.1.0 (aaaaaaa)',
		]);
	});

	test('catches up to the newest release when the run for it was dropped from the queue', async () => {
		publish('v1.0.0', OLD_SHA);
		fake.refs.set('tags/v1', { type: 'commit', sha: OLD_SHA });
		publish('v1.2.0');
		passCi();
		publish('v1.1.1', BACKPORT_SHA);
		strictEqual(await moveMajorTag(options('v1.1.1')), 'moved');
		deepStrictEqual(fake.refWrites, [{ method: 'PATCH', ref: 'tags/v1', sha: SHA, force: true }]);
	});

	test('leaves out a triggering release that is no longer published', async () => {
		publish('v1.1.0', OLD_SHA);
		passCi(OLD_SHA);
		publish('v1.2.0', SHA, { prerelease: true });
		fake.refs.set('tags/v1', { type: 'commit', sha: SHA });
		strictEqual(await moveMajorTag(options('v1.2.0')), 'moved');
		deepStrictEqual(fake.refWrites, [{ method: 'PATCH', ref: 'tags/v1', sha: OLD_SHA, force: true }]);
		deepStrictEqual(warnings, ['v1.2.0 is no longer a published release, so v1 leaves it out']);
	});

	test('counts a just-published release that the list has not caught up to', async () => {
		publish('v1.0.0', OLD_SHA);
		fake.refs.set('tags/v1', { type: 'commit', sha: OLD_SHA });
		fake.unlistedReleases.push({ tag_name: 'v1.0.1', draft: false, prerelease: false });
		fake.refs.set('tags/v1.0.1', { type: 'commit', sha: SHA });
		passCi();
		strictEqual(await moveMajorTag(options('v1.0.1')), 'moved');
		deepStrictEqual(fake.refWrites, [{ method: 'PATCH', ref: 'tags/v1', sha: SHA, force: true }]);
		deepStrictEqual(warnings, []);
	});

	test('leaves the major tag alone when no published release remains', async () => {
		publish('v1.0.0', SHA, { draft: true });
		strictEqual(await moveMajorTag(options('v1.0.0')), 'unchanged');
		deepStrictEqual(fake.refWrites, []);
		deepStrictEqual(notices, ['v1 has no published release to follow']);
	});

	test('compares versions numerically, across pages, ignoring drafts, prereleases and other majors', async () => {
		fake.pageSize = 2;
		publish('v1.9.0', OLD_SHA);
		publish('v1.11.0', OLD_SHA, { draft: true });
		publish('v1.12.0', OLD_SHA, { prerelease: true });
		publish('v2.0.0', OLD_SHA);
		publish('v1.10.0');
		passCi();
		strictEqual(await moveMajorTag(options('v1.9.0')), 'created');
		deepStrictEqual(fake.refWrites, [{ method: 'POST', ref: 'tags/v1', sha: SHA }]);
	});

	test('follows an annotated release tag to its commit', async () => {
		publish('v2.0.0');
		fake.refs.set('tags/v2.0.0', { type: 'tag', sha: TAG_OBJECT });
		fake.tagObjects.set(TAG_OBJECT, { type: 'commit', sha: SHA });
		passCi();
		strictEqual(await moveMajorTag(options('v2.0.0')), 'created');
		deepStrictEqual(fake.refWrites, [{ method: 'POST', ref: 'tags/v2', sha: SHA }]);
	});

	test('refuses a tag that is not a plain version', async () => {
		for (const tag of ['v1.0', 'v1.0.0-rc.1', '1.0.0', 'v01.0.0', 'v1.00.0']) {
			await rejects(moveMajorTag(options(tag)), /is not a vMAJOR\.MINOR\.PATCH release tag/);
		}
		strictEqual(fake.requests.length, 0);
	});

	test('refuses a release whose commit is not on main', async () => {
		fake.branches.set('main', [OLD_SHA]);
		publish('v1.0.0');
		passCi();
		await rejects(moveMajorTag(options('v1.0.0')), /v1\.0\.0 \(bbbbbbb\) is not on main/);
		deepStrictEqual(fake.refWrites, []);
	});

	test('refuses a release whose commit has not passed every required workflow on main', async () => {
		publish('v1.0.0');
		run(CI, 'success');
		run(E2E, 'failure');
		run(E2E, 'success', { event: 'pull_request', head_branch: 'feature' });
		await rejects(moveMajorTag(options('v1.0.0')), (error: Error) => {
			match(error.message, /has no passing push run of \.github\/workflows\/e2e\.yaml on main/);
			match(error.message, /re-run this job once it passes/);
			return true;
		});
		run(E2E, null);
		await rejects(moveMajorTag(options('v1.0.0')), /e2e\.yaml/);
		deepStrictEqual(fake.refWrites, []);
	});

	test('judges each workflow by its newest run, across pages', async () => {
		fake.pageSize = 1;
		publish('v1.0.0');
		run(CI, 'success');
		run(E2E, 'failure');
		run(E2E, 'success');
		strictEqual(await moveMajorTag(options('v1.0.0')), 'created');
	});

	test('reports an API failure as it is, never as a missing tag or run', async () => {
		publish('v1.0.0');
		passCi();
		fake.failNext(/^GET \/releases$/, 404);
		await rejects(moveMajorTag(options('v1.0.0')), /GET \/repos\/HarperFast\/deploy-action\/releases answered 404/);
		fake.failNext(/^GET \/actions\/runs$/, 404);
		await rejects(
			moveMajorTag(options('v1.0.0')),
			/GET \/repos\/HarperFast\/deploy-action\/actions\/runs answered 404/
		);
		deepStrictEqual(fake.refWrites, []);
	});

	test('runs as the workflow step, reporting failures as error annotations', async () => {
		publish('v1.0.0');
		passCi();
		const env = { PATH: process.env.PATH, GITHUB_API_URL: fake.url, GITHUB_TOKEN: 'token' };
		const missing = await runStep(env);
		strictEqual(missing.status, 1);
		match(missing.stdout, /^::error::GITHUB_REPOSITORY is not set$/m);

		const step = await runStep({ ...env, GITHUB_REPOSITORY: 'HarperFast/deploy-action', RELEASE_TAG: 'v1.0.0' });
		strictEqual(step.status, 0, step.stderr);
		match(step.stdout, /^::notice::v1 now points to v1\.0\.0 \(bbbbbbb\)$/m);
		deepStrictEqual(fake.refWrites, [{ method: 'POST', ref: 'tags/v1', sha: SHA }]);
	});
});
