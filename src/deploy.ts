import { resolve } from 'node:path';
import type { RunHarper } from './harperCli.ts';
import type { Inputs } from './inputs.ts';

export interface ActionResult {
	outcome: string;
	url?: string;
}

function deployArguments(inputs: Inputs): string[] {
	return [
		'deploy',
		`project=${inputs.app}`,
		`restart=${inputs.restart}`,
		...(inputs.byRef ? ['by_ref=true'] : []),
		...(inputs.ref ? [`ref=${inputs.ref}`] : []),
		...(inputs.credential ? ['credential=true'] : []),
		...inputs.args,
	];
}

export async function runDeploy(inputs: Inputs, harper: RunHarper): Promise<ActionResult> {
	// By reference, the workspace is where a checkout's git remote can resolve `ref`.
	const { exitCode } = await harper(deployArguments(inputs), {
		cwd: inputs.byRef ? process.cwd() : resolve(inputs.path),
	});
	if (exitCode !== 0) throw new Error(`harper deploy exited with ${exitCode}`);
	return { outcome: 'deployed' };
}
