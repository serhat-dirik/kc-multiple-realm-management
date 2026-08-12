#!/usr/bin/env bash
# Smoke-test every path the demo demonstrates. Non-zero exit on failure.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

bold "Verifying the demo"
exec python3 "$REPO_ROOT/scripts/verify.py" "$REPO_ROOT"
