#!/usr/bin/env bash
# Start App 2 - Option B, one confidential client on the umbrella realm.
#
# Pass -f to follow this component's logs after it starts.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

bold "Starting App 2 (Option B)"
ensure_runtime || exit 1
compose up -d --build app2
wait_for_url "$APP2_URL/healthz" "App 2" || exit 1
ok "App 2  $APP2_URL  - holds 1 client secret, knows 0 tenants"

# `-f` / `--follow` attaches to the logs after starting, for when you want to
# watch this component rather than just launch it.
if [ "${1:-}" = "-f" ] || [ "${1:-}" = "--follow" ]; then
  info "following logs — Ctrl-C stops watching, the container keeps running"
  compose logs -f --tail=50 app2
fi
