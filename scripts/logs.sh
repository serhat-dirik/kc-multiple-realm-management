#!/usr/bin/env bash
#
# Watch container logs. This is the first thing to reach for when something
# misbehaves — the start scripts run everything detached, so nothing is on
# screen by default.
#
#   ./scripts/logs.sh                      follow everything, interleaved
#   ./scripts/logs.sh keycloak             follow just Keycloak
#   ./scripts/logs.sh keycloak app2        follow two, prefixed and interleaved
#   ./scripts/logs.sh app2 --tail 500
#   ./scripts/logs.sh --no-follow          dump what exists and exit
#
# Services: keycloak · lldap · app1 · app2
#
# Note this does NOT use `compose logs`. Podman on macOS talks to its VM over a
# remote socket, and `podman compose logs` refuses more than one container in
# that mode ("logs does not support multiple containers when run remotely"), so
# each container is tailed separately and the streams are merged here.
#
set -uo pipefail
. "$(dirname "$0")/lib.sh"

FOLLOW="-f"
TAIL="100"
SERVICES=""

add_service() { case " $SERVICES " in *" $1 "*) ;; *) SERVICES="$SERVICES $1" ;; esac; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-follow) FOLLOW=""; shift ;;
    -f|--follow) FOLLOW="-f"; shift ;;
    --tail)      TAIL="${2:-100}"; shift 2 ;;
    --tail=*)    TAIL="${1#--tail=}"; shift ;;
    kc|keycloak) add_service keycloak; shift ;;
    ldap|lldap)  add_service lldap; shift ;;
    app1|app-1)  add_service app1; shift ;;
    app2|app-2)  add_service app2; shift ;;
    all)         SERVICES=""; shift ;;
    -h|--help)   sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Services: keycloak, lldap, app1, app2. Try --help." >&2
      exit 1 ;;
  esac
done

ensure_runtime || exit 1

[ -z "$SERVICES" ] && SERVICES="keycloak lldap app1 app2"

# Colour each stream so interleaved output stays readable.
colour_for() {
  case "$1" in
    keycloak) printf '36' ;;   # cyan
    lldap)    printf '35' ;;   # magenta
    app1)     printf '31' ;;   # red, matching App 1's badge
    app2)     printf '34' ;;   # blue, matching App 2's badge
    *)        printf '37' ;;
  esac
}

PIDS=""
cleanup() { [ -n "$PIDS" ] && kill $PIDS 2>/dev/null; }
trap cleanup INT TERM EXIT

started=0
for svc in $SERVICES; do
  container="kc-demo-$svc"
  if ! $CRI container exists "$container" 2>/dev/null; then
    fail "$container is not running"
    continue
  fi
  c=$(colour_for "$svc")
  # shellcheck disable=SC2086 — $FOLLOW must expand to a flag or to nothing
  ( $CRI logs $FOLLOW --tail "$TAIL" "$container" 2>&1 \
      | sed -u "s/^/$(printf '\033[%sm%-8s\033[0m │ ' "$c" "$svc")/" 2>/dev/null \
    || $CRI logs $FOLLOW --tail "$TAIL" "$container" 2>&1 | sed "s/^/$svc │ /" ) &
  PIDS="$PIDS $!"
  started=$((started + 1))
done

if [ "$started" -eq 0 ]; then
  info "nothing to tail — try ./scripts/start-all.sh"
  exit 1
fi

[ -n "$FOLLOW" ] && info "following:$SERVICES — Ctrl-C to stop"

wait
