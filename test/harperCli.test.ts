import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { suite, test } from 'node:test';
import { cliEnvironment, createHarperRunner, installHarperCli } from '../src/harperCli.ts';

const identity = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request' };

function executable(path: string, source: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `#!/usr/bin/env node\n${source}`);
	chmodSync(path, 0o755);
	return path;
}

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'harper-cli-test-')));

suite('harper CLI', () => {
	test('removes every credential the CLI would prefer to the identity token, and the action inputs', () => {
		const env = cliEnvironment(
			{
				PATH: '/bin',
				HARPER_CLI_USERNAME: 'a',
				HARPER_CLI_PASSWORD: 'b',
				HARPER_CLI_OPERATION_TOKEN: '',
				HARPER_CLI_REFRESH_TOKEN: 'c',
				CLI_TARGET_USERNAME: 'd',
				CLI_TARGET_PASSWORD: 'e',
				CLI_TARGET_OPERATION_TOKEN: 'f',
				CLI_TARGET_REFRESH_TOKEN: 'g',
				INPUT_GITHUB_TOKEN: 'h',
				HARPER_CLI_TARGET: 'https://other.example.com/',
				...identity,
			},
			'https://cluster.example.com:9925/'
		);
		deepStrictEqual(env, {
			PATH: '/bin',
			HARPER_CLI_TARGET: 'https://cluster.example.com:9925/',
			...identity,
		});
	});

	test('reports the exit code and stdout, and keeps a quiet command out of the log', async (context) => {
		const write = context.mock.method(process.stdout, 'write', () => true);
		const cliPath = executable(
			join(scratch(), 'harper'),
			`console.log(process.argv.slice(2).join(' '), process.cwd() === process.env.EXPECTED_CWD);process.exit(3);`
		);
		const cwd = scratch();
		const run = createHarperRunner({
			version: 'unused',
			target: 'https://cluster.example.com/',
			cliPath,
			env: { ...process.env, ...identity, EXPECTED_CWD: cwd },
		});
		const result = await run(['preview', 'list'], { cwd, quiet: true });
		context.mock.restoreAll();
		strictEqual(result.exitCode, 3);
		match(result.stdout, /^preview list true/);
		const logged = write.mock.calls.filter((call) => String(call.arguments[0]).includes('preview list'));
		strictEqual(logged.length, 0);
	});

	test('passes a value with shell metacharacters as one argument', async () => {
		const cliPath = executable(join(scratch(), 'harper'), `console.log(JSON.stringify(process.argv.slice(2)));`);
		const run = createHarperRunner({
			version: 'unused',
			target: 'https://cluster.example.com/',
			cliPath,
			env: { ...process.env, ...identity },
		});
		const branch = 'branch=$(touch pwned);`x`|y';
		const { stdout } = await run([branch], { quiet: true });
		deepStrictEqual(JSON.parse(stdout), [branch]);
	});

	test('refuses to run without an identity token, naming the permission', async () => {
		const run = createHarperRunner({ version: 'unused', target: 'https://x/', cliPath: 'unused', env: {} });
		await rejects(run(['deploy']), /permissions: id-token: write/);
	});

	test('installs on first use only, in an empty directory, without running scripts', async (context) => {
		context.mock.method(process.stdout, 'write', () => true);
		const home = scratch();
		const npm = executable(
			join(home, 'bin', 'npm'),
			`require('node:fs').appendFileSync(process.env.NPM_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
require('node:fs').mkdirSync(prefix + '/node_modules/.bin', { recursive: true });
require('node:fs').writeFileSync(prefix + '/node_modules/.bin/harper', '#!/usr/bin/env node\\n', { mode: 0o755 });`
		);
		const env = {
			...process.env,
			...identity,
			NPM_LOG: join(home, 'npm.log'),
			PATH: `${dirname(npm)}${delimiter}${process.env.PATH}`,
			RUNNER_TEMP: home,
		};
		const run = createHarperRunner({ version: '>=5.4.0-alpha.1 <6', target: 'https://x/', env });
		await run(['one']);
		await run(['two']);
		context.mock.restoreAll();
		const installs = readFileSync(env.NPM_LOG, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		strictEqual(installs.length, 1);
		ok(installs[0].args.includes('--ignore-scripts'));
		ok(installs[0].args.includes('harper@>=5.4.0-alpha.1 <6'));
		strictEqual(installs[0].cwd, installs[0].args[installs[0].args.indexOf('--prefix') + 1]);
	});

	test('fails when npm does', async (context) => {
		context.mock.method(process.stdout, 'write', () => true);
		const npm = executable(join(scratch(), 'npm'), 'process.exit(7);');
		const env = { ...process.env, PATH: `${dirname(npm)}${delimiter}${process.env.PATH}`, RUNNER_TEMP: scratch() };
		await rejects(installHarperCli('5.4.0', env), /npm could not install harper@5\.4\.0: it exited with 7/);
	});
});
