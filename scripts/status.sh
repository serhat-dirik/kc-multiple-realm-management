#!/usr/bin/env bash
#
# One-screen health check. Run this first when something looks wrong — it tells
# you which layer is broken before you go reading logs.
#
set -uo pipefail
. "$(dirname "$0")/lib.sh"

bold "Container runtime"
if $CRI ps >/dev/null 2>&1; then
  ok "$CRI reachable"
else
  fail "$CRI not reachable"
  if [ "$CRI" = "podman" ]; then
    info "the VM is probably stopped — any start script will bring it up, or: podman machine start"
  else
    info "start Docker Desktop, or: sudo systemctl start docker"
  fi
  exit 1
fi

bold "Containers"
found=0
for c in kc-demo-keycloak kc-demo-lldap kc-demo-app1 kc-demo-app2; do
  line=$($CRI ps -a --filter "name=^${c}$" --format '{{.Status}}|{{.Image}}' 2>/dev/null | head -1)
  if [ -z "$line" ]; then
    fail "$(printf '%-18s not created' "$c")"
  else
    st="${line%%|*}"; img="${line##*|}"
    case "$st" in
      Up*) ok "$(printf '%-18s %-22s %s' "$c" "$st" "$img")"; found=$((found+1)) ;;
      *)   fail "$(printf '%-18s %s' "$c" "$st")" ;;
    esac
  fi
done
[ "$found" -eq 0 ] && { info "nothing running — try ./scripts/start-all.sh"; exit 1; }

bold "Endpoints"
check_url() { # url label
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$1" 2>/dev/null)
  if [ "$code" = "200" ]; then ok "$(printf '%-22s %s' "$2" "$1")"
  else fail "$(printf '%-22s %s  (HTTP %s)' "$2" "$1" "$code")"; fi
}
check_url "$KC_MGMT/health/ready"                    "Keycloak"
check_url "$LLDAP_URL/health"                        "lldap"
check_url "$APP1_URL/healthz"                        "App 1"
check_url "$APP2_URL/healthz"                        "App 2"

bold "Realms"
TOKEN=$(kc_token)
if [ -z "$TOKEN" ]; then
  fail "cannot get an admin token — check Keycloak logs: ./scripts/logs.sh keycloak"
  exit 1
fi
kc_api "$TOKEN" GET /admin/realms \
  | python3 -c '
import sys, json
rs = sorted(r["realm"] for r in json.load(sys.stdin) if r["realm"] != "master")
print("  " + ("✓" if len(rs) == 7 else "✗"), f"{len(rs)}/7 imported:", ", ".join(rs))'

bold "Users"
for r in umbrella org-b; do
  kc_api "$TOKEN" GET "/admin/realms/$r/users?max=100" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('  %-9s %2d  %s' % ('$r', len(d), sorted(u['username'] for u in d)))"
done
info "a freshly reset demo has 0 umbrella users — they appear only as people sign in"

echo
info "logs: ./scripts/logs.sh [keycloak|lldap|app1|app2]"
