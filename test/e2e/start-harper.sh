#!/usr/bin/env bash
# Starts Harper on this machine, with the identity the normal deploy authenticates as.
set -euo pipefail

: "${E2E_ROOT:?the directory for Harper, short enough for Unix sockets}"
: "${E2E_HARPER_PACKAGE:=harper@${E2E_HARPER_VERSION:?the harper version to install}}"
target="${E2E_TARGET:-http://127.0.0.1:9925}"
http_port="${E2E_HTTP_PORT:-9926}"
https_port="${E2E_HTTPS_PORT:-9927}"
operations_port="${target##*:}"
admin="e2e-admin:e2e-Admin-Password1"

mkdir -p "$E2E_ROOT/home"
npm install --prefix "$E2E_ROOT/cli" --ignore-scripts --no-audit --no-fund "$E2E_HARPER_PACKAGE"

# HOME keeps Harper's boot file out of the real one; the lifecycle test writes the git config.
HOME="$E2E_ROOT/home" \
	GIT_CONFIG_GLOBAL="$E2E_ROOT/gitconfig" \
	HARPER_SET_CONFIG='{"authentication":{"authorizeLocal":false},"threads":{"count":1,"maxIsolated":4},"tls":{"unixDomainSockets":true}}' \
	nohup node "$E2E_ROOT/cli/node_modules/harper/dist/bin/harper.js" run \
	"--ROOTPATH=$E2E_ROOT/root" \
	"--HDB_ADMIN_USERNAME=${admin%%:*}" \
	"--HDB_ADMIN_PASSWORD=${admin#*:}" \
	--TC_AGREEMENT=yes \
	--THREADS_COUNT=1 \
	--NODE_HOSTNAME=127.0.0.1 \
	"--HTTP_PORT=127.0.0.1:$http_port" \
	"--HTTP_SECUREPORT=127.0.0.1:$https_port" \
	"--OPERATIONSAPI_NETWORK_PORT=127.0.0.1:$operations_port" \
	--LOGGING_LEVEL=info \
	--LOGGING_STDSTREAMS=false \
	>"$E2E_ROOT/harper.log" 2>&1 &
echo "$!" >"$E2E_ROOT/harper.pid"

operation() {
	curl --silent --show-error --fail-with-body --user "$admin" --header 'Content-Type: application/json' \
		--data "$1" "$target/"
	echo
}

curl --silent --output /dev/null --retry 60 --retry-delay 1 --retry-connrefused --user "$admin" \
	--header 'Content-Type: application/json' --data '{"operation":"registration_info"}' "$target/"

operation '{"operation":"add_role","role":"e2e-deploy-ci-deploy","permission":{"super_user":false,"operations":["deploy_component","get_deployment","get_job","registration_info"]}}'
operation '{"operation":"add_user","username":"e2e-deploy-ci-deploy","role":"e2e-deploy-ci-deploy","active":true,"password":"e2e-Deploy-Password1"}'

if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
	operation "$(jq --null-input \
		--arg audience "$target/" \
		--arg repository_id "$GITHUB_REPOSITORY_ID" \
		--arg workflow_ref "$GITHUB_WORKFLOW_REF" \
		--arg event_name "$GITHUB_EVENT_NAME" \
		'{
			operation: "add_oidc_trust",
			id: "e2e-deploy",
			issuer: "https://token.actions.githubusercontent.com",
			audience: $audience,
			user: "e2e-deploy-ci-deploy",
			claims: { repository_id: $repository_id, workflow_ref: $workflow_ref, event_name: $event_name }
		}')"
fi
