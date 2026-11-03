const APP_NAME = /^[a-zA-Z0-9-_]+$/;
const ARGUMENT = /^([a-zA-Z_]\w*)=/;
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;
/** The first release with `harper preview`; `^5.4` would not match it, or any 5.4 prerelease. */
export const DEFAULT_HARPER_VERSION = '>=5.4.0-alpha.1 <6';
// The action authenticates with the job's identity token alone, and `target` is its own input.
const CREDENTIAL_ARGUMENTS = new Set([
	'target',
	'username',
	'password',
	'auth_username',
	'auth_password',
	'operation_token',
	'refresh_token',
]);
// What the action sets itself: the CLI takes the last value, so an argument could deploy another commit or preview.
const ACTION_ARGUMENTS = new Set([
	'project',
	'app',
	'pr',
	'branch',
	'by_ref',
	'ref',
	'sha',
	'restart',
	'credential',
	'domain',
	'label',
	'ttl',
	'branchedDatabases',
	'repository',
]);

export interface Inputs {
	target: string;
	app: string;
	preview: boolean;
	path: string;
	byRef: boolean;
	ref?: string;
	restart: string;
	credential: boolean;
	domain?: string;
	label?: string;
	ttl?: string;
	branchedDatabases: boolean;
	comment: boolean;
	githubDeployment: boolean;
	deploymentEnvironment: string;
	args: string[];
	harperVersion: string;
	timeoutMinutes: number;
	githubToken: string;
}

function optionalInput(env: NodeJS.ProcessEnv, name: string): string | undefined {
	return env[`INPUT_${name}`]?.trim() || undefined;
}

function booleanInput(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
	const value = optionalInput(env, name)?.toLowerCase();
	if (value === undefined) return fallback;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error(`Input ${name.toLowerCase()} must be true or false, got ${JSON.stringify(value)}`);
}

function timeoutInput(env: NodeJS.ProcessEnv): number {
	const value = optionalInput(env, 'TIMEOUT_MINUTES') ?? '30';
	const minutes = Number(value);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		throw new Error(`Input timeout_minutes must be a positive number, got ${JSON.stringify(value)}`);
	}
	return minutes;
}

function targetInput(env: NodeJS.ProcessEnv): string {
	const target = optionalInput(env, 'TARGET');
	if (!target) {
		throw new Error(
			'Input target is empty. Pass the cluster URL, usually from the HARPER_CLI_TARGET or HARPER_PREVIEW_TARGET repository variable.'
		);
	}
	let url: URL;
	try {
		url = new URL(target);
	} catch (cause) {
		throw new Error(`Input target must be a URL such as https://cluster.example.com:9925/`, { cause });
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error(`Input target must be an http or https URL, got ${url.protocol}`);
	}
	if (url.protocol === 'http:' && !LOOPBACK_HOST.test(url.hostname)) {
		throw new Error(
			`Input target must use https: over http, ${url.hostname} would receive the identity exchange in plaintext`
		);
	}
	if (url.username || url.password) {
		throw new Error('Input target must not carry credentials: this action authenticates with OIDC only');
	}
	return target;
}

function extraArguments(env: NodeJS.ProcessEnv): string[] {
	const lines = env.INPUT_ARGS?.split('\n').map((line) => line.trim()) ?? [];
	return lines.filter(Boolean).map((line) => {
		const key = line.match(ARGUMENT)?.[1];
		if (!key) throw new Error(`Input args takes one key=value per line, got ${JSON.stringify(line)}`);
		if (CREDENTIAL_ARGUMENTS.has(key)) {
			throw new Error(`Input args cannot set ${key}: this action authenticates with OIDC only`);
		}
		if (ACTION_ARGUMENTS.has(key)) throw new Error(`Input args cannot set ${key}: the action sets it`);
		return line;
	});
}

export function readInputs(env: NodeJS.ProcessEnv): Inputs {
	const app = optionalInput(env, 'APP');
	if (!app || !APP_NAME.test(app)) {
		throw new Error(`Input app must be a component name (letters, numbers, "-" and "_"), got ${JSON.stringify(app)}`);
	}
	const preview = booleanInput(env, 'PREVIEW', false);
	const ref = optionalInput(env, 'REF');
	return {
		target: targetInput(env),
		app,
		preview,
		path: optionalInput(env, 'PATH') ?? '.',
		byRef: booleanInput(env, 'BY_REF', preview || ref !== undefined),
		ref,
		restart: optionalInput(env, 'RESTART') ?? 'rolling',
		credential: booleanInput(env, 'CREDENTIAL', false),
		domain: optionalInput(env, 'DOMAIN'),
		label: optionalInput(env, 'LABEL'),
		ttl: optionalInput(env, 'TTL'),
		branchedDatabases: booleanInput(env, 'BRANCHED_DATABASES', true),
		comment: booleanInput(env, 'COMMENT', true),
		githubDeployment: booleanInput(env, 'GITHUB_DEPLOYMENT', true),
		deploymentEnvironment: optionalInput(env, 'DEPLOYMENT_ENVIRONMENT') ?? `${app}-preview`,
		args: extraArguments(env),
		harperVersion: optionalInput(env, 'HARPER_VERSION') ?? DEFAULT_HARPER_VERSION,
		timeoutMinutes: timeoutInput(env),
		githubToken: env.INPUT_GITHUB_TOKEN ?? '',
	};
}
