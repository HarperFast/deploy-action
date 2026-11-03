import { readFile } from 'node:fs/promises';
import { runDeploy, type ActionResult } from './deploy.ts';
import { GitHubApi } from './githubApi.ts';
import { createHarperRunner, type HarperRunner } from './harperCli.ts';
import { readInputs, type Inputs } from './inputs.ts';
import { runPreview } from './preview.ts';
import { reportError, setOutput, workflowLog } from './workflowCommands.ts';

function requiredVariable(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set: this action runs in a GitHub Actions job`);
	return value;
}

async function preview(inputs: Inputs, harper: HarperRunner): Promise<ActionResult> {
	const repository = requiredVariable('GITHUB_REPOSITORY');
	const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
	const sleep = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));
	const payload = JSON.parse(await readFile(requiredVariable('GITHUB_EVENT_PATH'), 'utf8'));
	return runPreview(
		{
			inputs,
			harper,
			prepareHarper: harper.prepare,
			github: new GitHubApi({
				apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
				token: inputs.githubToken,
				repository,
				sleep,
			}),
			log: workflowLog,
			repository,
			runUrl: `${serverUrl}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
			sleep,
		},
		requiredVariable('GITHUB_EVENT_NAME'),
		payload
	);
}

async function main(): Promise<void> {
	const inputs = readInputs(process.env);
	const harper = createHarperRunner({
		version: inputs.harperVersion,
		target: inputs.target,
		timeoutMs: inputs.timeoutMinutes * 60_000,
		cliPath: process.env.HARPER_DEPLOY_ACTION_CLI,
	});
	const { outcome, url } = inputs.preview ? await preview(inputs, harper) : await runDeploy(inputs, harper);
	setOutput('outcome', outcome);
	if (url) setOutput('url', url);
}

try {
	await main();
} catch (error) {
	reportError((error as Error).message);
	process.exitCode = 1;
}
