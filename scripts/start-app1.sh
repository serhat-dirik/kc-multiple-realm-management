#!/usr/bin/env bash
# Start App 1 - Option A, one confidential client per tenant realm.
#
# Pass -f to follow this component's logs after it starts.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

bold "Starting App 1 (Option A)"
ensure_runtime || exit 1
compose up -d --build app1
wait_for_url "$APP1_URL/healthz" "App 1" || exit 1
ok "App 1  $APP1_URL  - holds 5 client secrets"

# `-f` / `--follow` attaches to the logs after starting, for when you want to
# watch this component rather than just launch it.
if [ "${1:-}" = "-f" ] || [ "${1:-}" = "--follow" ]; then
  info "following logs — Ctrl-C stops watching, the container keeps running"
  compose logs -f --tail=50 app1
fi
