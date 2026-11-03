import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HarperResult {
	exitCode: number;
	stdout: string;
}

export interface HarperOptions {
	cwd?: string;
	quiet?: boolean;
}

export type RunHarper = (args: string[], options?: HarperOptions) => Promise<HarperResult>;

/** `prepare` installs the CLI without running it, so a later command starts at once. */
export type HarperRunner = RunHarper & { prepare: () => Promise<void> };

export interface HarperRunnerOptions {
	version: string;
	target: string;
	timeoutMs: number;
	cliPath?: string;
	env?: NodeJS.ProcessEnv;
}

const KILL_GRACE_MS = 10_000;

// A configured credential outranks the job's identity token in the CLI, and a blank one disables it.
const CREDENTIAL_VARIABLE = /^(?:HARPER_CLI|CLI_TARGET)_(?:USERNAME|PASSWORD|OPERATION_TOKEN|REFRESH_TOKEN)$/;
const DOTENV_CREDENTIAL =
	/^\s*(?:export\s+)?((?:HARPER_CLI|CLI_TARGET)_(?:USERNAME|PASSWORD|OPERATION_TOKEN|REFRESH_TOKEN))\s*[=:]/m;

function without(env: NodeJS.ProcessEnv, variable: RegExp): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([name]) => !variable.test(name)));
}

/** `home` replaces HOME, where the CLI keeps `harper login` credentials, which also outrank the identity token. */
export function cliEnvironment(env: NodeJS.ProcessEnv, target: string, home: string): NodeJS.ProcessEnv {
	const filtered = without(without(env, /^INPUT_/), CREDENTIAL_VARIABLE);
	return { ...filtered, HARPER_CLI_TARGET: target, HOME: home, USERPROFILE: home };
}

/** The CLI loads `.env` from where it runs, for any variable not already set. */
async function assertNoDotenvCredentials(directory: string): Promise<void> {
	const dotenv = await readFile(join(directory, '.env'), 'utf8').catch(() => '');
	const credential = dotenv.match(DOTENV_CREDENTIAL)?.[1];
	if (credential) {
		throw new Error(
			`${join(directory, '.env')} sets ${credential}, which the CLI would use instead of the identity token. ` +
				'Leave CLI credentials out of the deployed directory.'
		);
	}
}

function execute(
	command: string,
	args: string[],
	{ cwd, env, quiet, label, timeoutMs }: HarperOptions & { env: NodeJS.ProcessEnv; label: string; timeoutMs: number }
): Promise<HarperResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill('SIGTERM');
			setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
			reject(new Error(`${label} did not finish within ${timeoutMs / 60_000} minutes`));
		}, timeoutMs);
		child.stdout.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
			if (!quiet) process.stdout.write(chunk);
		});
		child.on('error', (cause) => {
			clearTimeout(timer);
			reject(new Error(`Could not run ${command}: ${cause.message}`, { cause }));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') });
		});
	});
}

/**
 * Installs into an empty directory so a project `.npmrc` in the workspace cannot redirect the CLI that receives the
 * job's identity. Scripts stay off for the same reason: the CLI needs none of its dependencies' to deploy.
 */
export async function installHarperCli(version: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
	const directory = await mkdtemp(join(env.RUNNER_TEMP ?? tmpdir(), 'harper-cli-'));
	const { exitCode } = await execute(
		'npm',
		[
			'install',
			'--prefix',
			directory,
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			'--no-package-lock',
			`harper@${version}`,
		],
		{ cwd: directory, env: without(env, /^(?:INPUT_|ACTIONS_ID_TOKEN_)/), label: 'npm install', timeoutMs }
	);
	if (exitCode !== 0) throw new Error(`npm could not install harper@${version}: it exited with ${exitCode}`);
	return join(directory, 'node_modules', '.bin', 'harper');
}

/** Without a `cwd` the CLI runs in an empty directory, where there is no `.env` for it to load. */
export function createHarperRunner({
	version,
	target,
	timeoutMs,
	cliPath,
	env = process.env,
}: HarperRunnerOptions): HarperRunner {
	let installed: Promise<string> | undefined = cliPath ? Promise.resolve(cliPath) : undefined;
	let scratch: Promise<{ home: string; work: string }> | undefined;
	const prepare = async () => {
		if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
			throw new Error('This job has no identity token: grant it `permissions: id-token: write`');
		}
		scratch ??= mkdtemp(join(env.RUNNER_TEMP ?? tmpdir(), 'harper-run-')).then(async (root) => {
			const directories = { home: join(root, 'home'), work: join(root, 'work') };
			await Promise.all([mkdir(directories.home), mkdir(directories.work)]);
			return directories;
		});
		const directories = await scratch;
		installed ??= installHarperCli(version, env, timeoutMs);
		return { cli: await installed, ...directories };
	};
	const run: RunHarper = async (args, { cwd, quiet } = {}) => {
		const { cli, home, work } = await prepare();
		if (cwd) await assertNoDotenvCredentials(cwd);
		return execute(cli, args, {
			cwd: cwd ?? work,
			quiet,
			env: cliEnvironment(env, target, home),
			label: ['harper', ...args.slice(0, 2)].join(' '),
			timeoutMs,
		});
	};
	return Object.assign(run, { prepare: async () => void (await prepare()) });
}
