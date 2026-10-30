import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
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

export interface HarperRunnerOptions {
	version: string;
	target: string;
	/** An installed CLI to run instead of installing `version`. */
	cliPath?: string;
	env?: NodeJS.ProcessEnv;
}

// A configured credential outranks the job's identity token in the CLI, and a blank one disables it.
const CREDENTIAL_VARIABLE = /^(?:HARPER_CLI|CLI_TARGET)_(?:USERNAME|PASSWORD|OPERATION_TOKEN|REFRESH_TOKEN)$/;

export function cliEnvironment(env: NodeJS.ProcessEnv, target: string): NodeJS.ProcessEnv {
	const filtered: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(env)) {
		if (!CREDENTIAL_VARIABLE.test(name) && !name.startsWith('INPUT_')) filtered[name] = value;
	}
	filtered.HARPER_CLI_TARGET = target;
	return filtered;
}

function execute(
	command: string,
	args: string[],
	{ cwd, env, quiet }: HarperOptions & { env: NodeJS.ProcessEnv }
): Promise<HarperResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
		const chunks: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
			if (!quiet) process.stdout.write(chunk);
		});
		child.on('error', (cause) => reject(new Error(`Could not run ${command}: ${cause.message}`, { cause })));
		child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') }));
	});
}

/**
 * Installs into an empty directory so a project `.npmrc` in the workspace cannot redirect the CLI that receives the
 * job's identity. Scripts stay off for the same reason: the CLI needs none of its dependencies' to deploy.
 */
export async function installHarperCli(version: string, env: NodeJS.ProcessEnv): Promise<string> {
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
		{ cwd: directory, env }
	);
	if (exitCode !== 0) throw new Error(`npm could not install harper@${version}: it exited with ${exitCode}`);
	return join(directory, 'node_modules', '.bin', 'harper');
}

/** The CLI is installed on first use, so a run that has nothing to do never installs it. */
export function createHarperRunner({ version, target, cliPath, env = process.env }: HarperRunnerOptions): RunHarper {
	let installed: Promise<string> | undefined = cliPath ? Promise.resolve(cliPath) : undefined;
	return async (args, options = {}) => {
		if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
			throw new Error('This job has no identity token: grant it `permissions: id-token: write`');
		}
		installed ??= installHarperCli(version, env);
		return execute(await installed, args, { ...options, env: cliEnvironment(env, target) });
	};
}
