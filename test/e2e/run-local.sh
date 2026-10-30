#!/usr/bin/env bash
# The e2e run without a GitHub runner: real Harper and password authentication instead of OIDC.
set -euo pipefail

repository="$(cd "$(dirname "$0")/../.." && pwd)"
export E2E_ROOT="${E2E_ROOT:-/tmp/harper-e2e}"
export E2E_HARPER_VERSION="${E2E_HARPER_VERSION:-5.4.0-alpha.1}"
export E2E_TARGET="${E2E_TARGET:-http://127.0.0.1:19925}"
export E2E_HTTP_PORT="${E2E_HTTP_PORT:-19926}"
export E2E_HTTPS_PORT="${E2E_HTTPS_PORT:-19927}"

rm -rf "$E2E_ROOT"
trap 'kill "$(cat "$E2E_ROOT/harper.pid")" 2>/dev/null || true' EXIT
"$repository/test/e2e/start-harper.sh"
node --test "$repository/test/e2e/lifecycle.test.ts"
