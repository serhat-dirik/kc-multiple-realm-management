#!/usr/bin/env bash
# Start Keycloak + lldap, then seed the org-b directory.
#
# Pass -f to follow this component's logs after it starts.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

bold "Starting Keycloak and lldap"
ensure_runtime || exit 1
compose up -d keycloak lldap
wait_for_keycloak || exit 1
wait_for_lldap    || exit 1
"$REPO_ROOT/scripts/seed-lldap.sh" || exit 1
ok "Keycloak  $KC_URL  ($KC_ADMIN / $KC_ADMIN_PASS)"
ok "lldap     $LLDAP_URL  (admin / adminadmin)"

# `-f` / `--follow` attaches to the logs after starting, for when you want to
# watch this component rather than just launch it.
if [ "${1:-}" = "-f" ] || [ "${1:-}" = "--follow" ]; then
  info "following logs — Ctrl-C stops watching, the container keeps running"
  compose logs -f --tail=50 keycloak lldap
fi
