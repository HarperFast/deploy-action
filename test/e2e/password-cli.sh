#!/usr/bin/env bash
# Stands in for the CLI where there is no GitHub identity token: the action strips credentials from its environment.
set -euo pipefail

HARPER_CLI_USERNAME="$E2E_USERNAME" HARPER_CLI_PASSWORD="$E2E_PASSWORD" exec "$E2E_ROOT/cli/node_modules/.bin/harper" "$@"
