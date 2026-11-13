import { deepStrictEqual, match, rejects, strictEqual } from 'node:assert';
import { after, before, beforeEach, suite, test } from 'node:test';
import { moveMajorTag, type MoveMajorTagOptions } from '../scripts/moveMajorTag.ts';
import { FakeGitHub, type FakeWorkflowRun } from './support/fakeGitHub.ts';

const OLD_SHA = 'a'.repeat(40);
const SHA = 'b'.repeat(40);
const TAG_OBJECT = 'c'.repeat(40);
const CI = '.github/workflows/ci.yaml';
const E2E = '.github/workflows/e2e.yaml';

suite('moveMajorTag', () => {
	const fake = new FakeGitHub();
	let notices: string[];
	let nextRun: number;

	before(() => fake.start());
	after(() => fake.stop());
	beforeEach(() => {
		notices = [];
		nextRun = 1;
		fake.pageSize = 100;
		fake.releases = [];
		fake.refs.clear();
		fake.tagObjects.clear();
		fake.branchCommits = new Set([OLD_SHA, SHA]);
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

	function passCi(): void {
		run(CI, 'success');
		run(E2E, 'success');
	}

	function options(tag: string): MoveMajorTagOptions {
		return {
			apiUrl: fake.url,
			token: 'token',
			repository: 'HarperFast/deploy-action',
			tag,
			branch: 'main',
			requiredWorkflows: [CI, E2E],
			log: { notice: (message) => notices.push(message), warning: () => {} },
		};
	}

	test('creates the major tag for a first release', async () => {
		publish('v1.0.0');
		passCi();
		strictEqual(await moveMajorTag(options('v1.0.0')), 'created');
		deepStrictEqual(fake.refWrites, [{ method: 'POST', ref: 'tags/v1', sha: SHA }]);
		deepStrictEqual(notices, [`v1 now points to v1.0.0 (bbbbbbb)`]);
	});

	test('force-moves the major tag to a newer release', async () => {
		publish('v1.0.0', OLD_SHA);
		fake.refs.set('tags/v1', { type: 'commit', sha: OLD_SHA });
		publish('v1.0.1');
		passCi();
		strictEqual(await moveMajorTag(options('v1.0.1')), 'moved');
		deepStrictEqual(fake.refWrites, [{ method: 'PATCH', ref: 'tags/v1', sha: SHA, force: true }]);
	});

	test('leaves a major tag that already points at the release', async () => {
		publish('v1.0.1');
		fake.refs.set('tags/v1', { type: 'commit', sha: SHA });
		passCi();
		strictEqual(await moveMajorTag(options('v1.0.1')), 'unchanged');
		deepStrictEqual(fake.refWrites, []);
	});

	test('keeps the major tag on a newer release when an older line is patched', async () => {
		publish('v1.1.0', OLD_SHA);
		fake.refs.set('tags/v1', { type: 'commit', sha: OLD_SHA });
		publish('v1.0.2');
		strictEqual(await moveMajorTag(options('v1.0.2')), 'kept');
		deepStrictEqual(fake.refWrites, []);
		deepStrictEqual(notices, ['v1 stays with v1.1.0, which is newer than v1.0.2']);
	});

	test('compares versions numerically, across pages, ignoring drafts, prereleases and other majors', async () => {
		fake.pageSize = 2;
		publish('v1.9.0', OLD_SHA);
		publish('v1.11.0', OLD_SHA, { draft: true });
		publish('v1.12.0', OLD_SHA, { prerelease: true });
		publish('v2.0.0', OLD_SHA);
		publish('v1.10.0');
		passCi();
		strictEqual(await moveMajorTag(options('v1.10.0')), 'created');
		deepStrictEqual(fake.refWrites, [{ method: 'POST', ref: 'tags/v1', sha: SHA }]);
	});

	test('follows an annotated tag to its commit', async () => {
		publish('v2.0.0');
		fake.refs.set('tags/v2.0.0', { type: 'tag', sha: TAG_OBJECT });
		fake.tagObjects.set(TAG_OBJECT, { type: 'commit', sha: SHA });
		passCi();
		strictEqual(await moveMajorTag(options('v2.0.0')), 'created');
		deepStrictEqual(fake.refWrites, [{ method: 'POST', ref: 'tags/v2', sha: SHA }]);
	});

	test('refuses a tag that is not a plain version', async () => {
		for (const tag of ['v1.0', 'v1.0.0-rc.1', '1.0.0']) {
			await rejects(moveMajorTag(options(tag)), /is not a vMAJOR\.MINOR\.PATCH release tag/);
		}
		deepStrictEqual(fake.requests.length, 0);
	});

	test('refuses a release whose commit is not on main', async () => {
		publish('v1.0.0');
		fake.branchCommits.delete(SHA);
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

	test('takes the newest run of each workflow, so a passing re-run counts', async () => {
		publish('v1.0.0');
		run(CI, 'success');
		run(E2E, 'failure');
		run(E2E, 'success');
		strictEqual(await moveMajorTag(options('v1.0.0')), 'created');
	});
});
