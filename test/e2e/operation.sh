#!/usr/bin/env bash
set -euo pipefail

curl --silent --show-error --fail-with-body --user e2e-admin:e2e-Admin-Password1 \
	--header 'Content-Type: application/json' --data "$1" "${E2E_TARGET:-http://127.0.0.1:9925}/"
echo
