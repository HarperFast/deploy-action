import { strictEqual } from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'node:test';
import { reportError, setOutput } from '../src/workflowCommands.ts';

suite('workflow commands', () => {
	test('escapes a message so it stays one command', (context) => {
		const log = context.mock.method(console, 'log', () => {});
		reportError('50% done\nnext');
		strictEqual(log.mock.calls[0].arguments[0], '::error::50%25 done%0Anext');
	});

	test('writes an output a newline cannot forge another output into', () => {
		const file = join(mkdtempSync(join(tmpdir(), 'outputs-')), 'output');
		setOutput('url', 'https://x/\nouter=1', file);
		const [start, ...rest] = readFileSync(file, 'utf8').trimEnd().split('\n');
		const delimiter = start.slice('url<<'.length);
		strictEqual(rest.join('\n'), `https://x/\nouter=1\n${delimiter}`);
	});
});
