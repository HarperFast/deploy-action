import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { suite, test } from 'node:test';
import { DEFAULT_HARPER_VERSION, readInputs } from '../src/inputs.ts';

const required = { INPUT_TARGET: 'https://cluster.example.com:9925/', INPUT_APP: 'shop' };

suite('readInputs', () => {
	test('a normal deploy defaults to a payload of the workspace, restarted rolling', () => {
		const inputs = readInputs(required);
		strictEqual(inputs.preview, false);
		strictEqual(inputs.byRef, false);
		strictEqual(inputs.path, '.');
		strictEqual(inputs.restart, 'rolling');
		strictEqual(inputs.harperVersion, DEFAULT_HARPER_VERSION);
	});

	test('a preview defaults to by_ref, branched data, a comment and a Deployment', () => {
		const inputs = readInputs({ ...required, INPUT_PREVIEW: 'true' });
		strictEqual(inputs.byRef, true);
		strictEqual(inputs.branchedDatabases, true);
		strictEqual(inputs.comment, true);
		strictEqual(inputs.githubDeployment, true);
		strictEqual(inputs.deploymentEnvironment, 'shop-preview');
	});

	test('a ref implies by_ref, and an explicit by_ref wins', () => {
		strictEqual(readInputs({ ...required, INPUT_REF: 'abc' }).byRef, true);
		strictEqual(readInputs({ ...required, INPUT_REF: 'abc', INPUT_BY_REF: 'false' }).byRef, false);
		strictEqual(readInputs({ ...required, INPUT_PREVIEW: 'true', INPUT_BY_REF: 'false' }).byRef, false);
	});

	test('blank optional inputs read as unset', () => {
		const inputs = readInputs({ ...required, INPUT_DOMAIN: ' ', INPUT_PATH: '', INPUT_DEPLOYMENT_ENVIRONMENT: '' });
		strictEqual(inputs.domain, undefined);
		strictEqual(inputs.path, '.');
		strictEqual(inputs.deploymentEnvironment, 'shop-preview');
	});

	test('names the missing target, which is usually an unset repository variable', () => {
		throws(() => readInputs({ INPUT_APP: 'shop' }), /target is empty.*HARPER_PREVIEW_TARGET/);
	});

	test('refuses a target that is not a URL, or carries credentials', () => {
		throws(() => readInputs({ ...required, INPUT_TARGET: 'cluster.example.com' }), /must be a URL/);
		throws(() => readInputs({ ...required, INPUT_TARGET: 'ftp://cluster.example.com/' }), /http or https/);
		throws(() => readInputs({ ...required, INPUT_TARGET: 'https://me:pw@cluster.example.com/' }), /OIDC only/);
	});

	test('refuses an app name the cluster would', () => {
		throws(() => readInputs({ ...required, INPUT_APP: 'shop/one' }), /component name/);
		throws(() => readInputs({ ...required, INPUT_APP: '' }), /component name/);
	});

	test('refuses a boolean it cannot read', () => {
		throws(() => readInputs({ ...required, INPUT_PREVIEW: 'yes' }), /preview must be true or false/);
	});

	test('args are one key=value per line, kept verbatim', () => {
		const inputs = readInputs({ ...required, INPUT_ARGS: 'package=npm:shop@1.2.3\n\n  keepBranches=true \n' });
		deepStrictEqual(inputs.args, ['package=npm:shop@1.2.3', 'keepBranches=true']);
	});

	test('args cannot bring in a credential or another target', () => {
		for (const argument of ['auth_password=x', 'auth_username=x', 'username=x', 'password=x', 'target=https://x/']) {
			throws(() => readInputs({ ...required, INPUT_ARGS: argument }), /OIDC only/);
		}
		throws(() => readInputs({ ...required, INPUT_ARGS: 'deploy' }), /one key=value per line/);
	});

	test('args cannot override what the action sets, such as the commit or the preview', () => {
		for (const key of ['project', 'app', 'pr', 'branch', 'by_ref', 'ref', 'sha', 'restart', 'domain', 'ttl']) {
			throws(
				() => readInputs({ ...required, INPUT_ARGS: `${key}=x` }),
				new RegExp(`cannot set ${key}: the action sets it`)
			);
		}
	});
});
