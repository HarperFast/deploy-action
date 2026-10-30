import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { suite, test } from 'node:test';
import { runDeploy } from '../src/deploy.ts';
import type { HarperOptions } from '../src/harperCli.ts';
import { readInputs } from '../src/inputs.ts';

const required = { INPUT_TARGET: 'https://cluster.example.com:9925/', INPUT_APP: 'shop' };

function fakeHarper(exitCode = 0) {
	const calls: { args: string[]; options?: HarperOptions }[] = [];
	return {
		calls,
		run: async (args: string[], options?: HarperOptions) => {
			calls.push({ args, options });
			return { exitCode, stdout: '' };
		},
	};
}

suite('runDeploy', () => {
	test('uploads the path as a payload', async () => {
		const harper = fakeHarper();
		const result = await runDeploy(readInputs({ ...required, INPUT_PATH: 'dist' }), harper.run);
		deepStrictEqual(harper.calls[0].args, ['deploy', 'project=shop', 'restart=rolling']);
		strictEqual(harper.calls[0].options?.cwd, resolve('dist'));
		strictEqual(result.outcome, 'deployed');
	});

	test('has the cluster fetch a ref, from wherever the job runs', async () => {
		const harper = fakeHarper();
		await runDeploy(
			readInputs({ ...required, INPUT_BY_REF: 'true', INPUT_REF: 'abc123', INPUT_CREDENTIAL: 'true' }),
			harper.run
		);
		deepStrictEqual(harper.calls[0].args, [
			'deploy',
			'project=shop',
			'restart=rolling',
			'by_ref=true',
			'ref=abc123',
			'credential=true',
		]);
		strictEqual(harper.calls[0].options?.cwd, process.cwd());
	});

	test('passes extra arguments through, and a restart other than rolling', async () => {
		const harper = fakeHarper();
		await runDeploy(readInputs({ ...required, INPUT_RESTART: 'true', INPUT_ARGS: 'wait=false' }), harper.run);
		deepStrictEqual(harper.calls[0].args, ['deploy', 'project=shop', 'restart=true', 'wait=false']);
	});

	test('fails when the CLI does', async () => {
		await rejects(runDeploy(readInputs(required), fakeHarper(1).run), /harper deploy exited with 1/);
	});
});
