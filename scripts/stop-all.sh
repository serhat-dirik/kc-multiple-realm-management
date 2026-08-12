#!/usr/bin/env bash
# Stop and remove the containers. Volumes are kept, so lldap data survives.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

bold "Stopping demo"
ensure_runtime || exit 1
compose down
ok "stopped (lldap volume kept - use reset.sh to wipe everything)"
