#!/usr/bin/env bash
# Start everything in order and print the credential sheet.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

"$REPO_ROOT/scripts/start-kc.sh"   || exit 1
"$REPO_ROOT/scripts/start-app1.sh" || exit 1
"$REPO_ROOT/scripts/start-app2.sh" || exit 1
print_credentials
