import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

export interface WorkflowLog {
	notice(message: string): void;
	warning(message: string): void;
}

function workflowCommand(command: string, message: string): string {
	const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
	return `::${command}::${escaped}`;
}

export const workflowLog: WorkflowLog = {
	notice: (message) => console.log(workflowCommand('notice', message)),
	warning: (message) => console.log(workflowCommand('warning', message)),
};

export function reportError(message: string): void {
	console.log(workflowCommand('error', message));
}

export function setOutput(name: string, value: string, outputFile = process.env.GITHUB_OUTPUT): void {
	if (!outputFile) return;
	const delimiter = `harper_${randomUUID()}`;
	appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
