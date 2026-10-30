import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { suite, test } from 'node:test';
import { DEFAULT_HARPER_VERSION } from '../src/inputs.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const action = read('action.yml');
const readme = read('README.md');

function declaredInputs(): string[] {
	const block = action.slice(action.indexOf('\ninputs:\n'), action.indexOf('\noutputs:\n'));
	return [...block.matchAll(/^ {2}([a-z_]+):$/gm)].map(([, name]) => name);
}

suite('action.yml', () => {
	test('hands every input to the script through the environment, never into the shell', () => {
		for (const name of declaredInputs()) {
			if (name === 'node_version') continue;
			match(action, new RegExp(`INPUT_${name.toUpperCase()}: \\$\\{\\{ inputs\\.${name} \\}\\}`));
		}
		const run = action.match(/^ {6}run: (.*)$/m)?.[1];
		strictEqual(run, 'node "$GITHUB_ACTION_PATH/src/main.ts"');
	});

	test('declares exactly the inputs the script reads', () => {
		const script = read('src/inputs.ts');
		const names = [...script.matchAll(/(?:optional|boolean)Input\(env, '([A-Z_]+)'|INPUT_([A-Z_]+)/g)].map(
			([, name, direct]) => (name ?? direct).toLowerCase()
		);
		deepStrictEqual(
			[...new Set(names)].sort(),
			declaredInputs()
				.filter((name) => name !== 'node_version')
				.sort()
		);
	});

	test('the default CLI matches the script’s fallback', () => {
		match(action, new RegExp(`default: '${DEFAULT_HARPER_VERSION}'`));
	});

	test('pins third-party actions to a commit', () => {
		const uses = [...action.matchAll(/uses: (\S+)/g)].map(([, reference]) => reference);
		ok(uses.length > 0);
		for (const reference of uses) match(reference, /@[0-9a-f]{40}$/);
	});
});

suite('example workflows', () => {
	const examples = ['deploy', 'preview', 'preview-sweep'].map((name) => read(`examples/${name}.yaml`));

	test('are in the README as they stand', () => {
		for (const example of examples) ok(readme.includes(example.trimEnd()), example.split('\n')[0]);
	});

	test('never check out code, so a PR cannot run with the identity', () => {
		for (const example of examples) doesNotMatch(example, /actions\/checkout/);
	});

	test('the preview workflow matches what `harper preview setup` pins', () => {
		const [, preview] = examples;
		match(preview, /pull_request_target:/);
		deepStrictEqual(
			[...preview.matchAll(/environment: (\S+)/g)].map(([, name]) => name),
			['preview', 'preview-cleanup']
		);
		const conditions = [...preview.matchAll(/^ {4}if: (.*)$/gm)].map(([, condition]) => condition);
		strictEqual(conditions.length, 2);
		for (const condition of conditions) {
			match(condition, /&& github\.event\.pull_request\.head\.repo\.full_name == github\.repository$/);
		}
		match(preview, /target: \$\{\{ vars\.HARPER_PREVIEW_TARGET \}\}/);
	});

	test('the production workflow matches what `harper deploy setup=true` pins', () => {
		const [deploy] = examples;
		match(deploy, /environment: production/);
		match(deploy, /target: \$\{\{ vars\.HARPER_CLI_TARGET \}\}/);
	});
});
