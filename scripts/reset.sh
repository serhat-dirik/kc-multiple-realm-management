#!/usr/bin/env bash
# Full wipe and rebuild.
#
# This matters more than it looks: Keycloak's start-dev uses a FILE-backed H2
# database, and --import-realm skips realms that already exist. So editing a
# realm JSON and merely restarting the container changes nothing. Only a full
# down/up re-imports.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

bold "Resetting demo (wiping all state, re-importing realms)"
ensure_runtime || exit 1
compose down -v
"$REPO_ROOT/scripts/start-all.sh"
