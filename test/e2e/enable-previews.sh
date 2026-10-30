#!/usr/bin/env bash
# 5.4.0-alpha.1 predates enable_previews, so there this writes the same records by hand, with the grant constraints
# that release knows.
set -euo pipefail

: "${E2E_APP:?the application}"
: "${E2E_REPOSITORY:?the repository, as owner/name}"
: "${E2E_REPOSITORY_ID:?the repository id}"
: "${E2E_DOMAIN:?the preview domain}"
operation="$(dirname "$0")/operation.sh"
audience="${E2E_TARGET:-http://127.0.0.1:9925}/"
user="$E2E_APP-ci-preview"
password=e2e-Preview-Password1

enabled=0
response="$("$operation" "$(jq --null-input \
	--arg app "$E2E_APP" \
	--arg repository "$E2E_REPOSITORY" \
	--arg repository_id "$E2E_REPOSITORY_ID" \
	--arg audience "$audience" \
	--arg hostSuffix ".$E2E_DOMAIN" \
	'{ operation: "enable_previews", app: $app, repository: $repository, repository_id: $repository_id,
		branch: "main", audience: $audience, hostSuffix: $hostSuffix }')")" || enabled=$?
echo "$response"
if [ "$enabled" -eq 0 ]; then
	"$operation" "$(jq --null-input --arg user "$user" --arg password "$password" \
		'{ operation: "alter_user", username: $user, password: $password }')"
	exit 0
fi
grep --quiet "Operation 'enable_previews' not found" <<<"$response"

"$operation" "$(jq --null-input --arg role "$user" --arg app "$E2E_APP" --arg hostSuffix ".$E2E_DOMAIN" \
	'{
		operation: "add_role",
		role: $role,
		permission: {
			super_user: false,
			operations: ["deploy_component", "drop_component", "get_components", "get_deployment", "registration_info"],
			component_deploy: {
				names: ["\($app)-pr-*"],
				constraints: { isolated: true, hostSuffix: $hostSuffix, branchedDatabases: "required" }
			}
		}
	}')"
"$operation" "$(jq --null-input --arg user "$user" --arg password "$password" \
	'{ operation: "add_user", username: $user, role: $user, active: true, password: $password }')"

trust_policy() {
	"$operation" "$(jq --null-input \
		--arg id "$1" \
		--arg environment "$2" \
		--argjson operations "$3" \
		--arg audience "$audience" \
		--arg user "$user" \
		--arg repository_id "$E2E_REPOSITORY_ID" \
		--arg workflow_ref "$E2E_REPOSITORY/.github/workflows/preview.yaml@refs/heads/main" \
		'{
			operation: "add_oidc_trust",
			id: $id,
			issuer: "https://token.actions.githubusercontent.com",
			audience: $audience,
			user: $user,
			operations: $operations,
			claims: {
				repository_id: $repository_id,
				workflow_ref: $workflow_ref,
				event_name: "pull_request_target",
				environment: $environment
			}
		}')"
}
trust_policy "github-actions-$E2E_APP-preview" preview \
	'["deploy_component", "drop_component", "get_components", "get_deployment", "registration_info"]'
trust_policy "github-actions-$E2E_APP-preview-cleanup" preview-cleanup '["drop_component"]'
