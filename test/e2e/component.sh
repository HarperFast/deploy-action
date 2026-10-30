#!/usr/bin/env bash
set -euo pipefail

"$(dirname "$0")/operation.sh" '{"operation":"get_components"}' |
	jq --arg name "$1" '.entries[] | select(.name == $name)'
