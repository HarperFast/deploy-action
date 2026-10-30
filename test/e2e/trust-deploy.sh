#!/usr/bin/env bash
set -euo pipefail

operation="$(dirname "$0")/operation.sh"
target="${E2E_TARGET:-http://127.0.0.1:9925}"

"$operation" '{"operation":"add_role","role":"e2e-deploy-ci-deploy","permission":{"super_user":false,"operations":["deploy_component","get_deployment","get_job","registration_info"]}}'
"$operation" '{"operation":"add_user","username":"e2e-deploy-ci-deploy","role":"e2e-deploy-ci-deploy","active":true,"password":"e2e-Deploy-Password1"}'
"$operation" "$(jq --null-input \
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
