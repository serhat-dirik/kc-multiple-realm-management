#!/usr/bin/env bash
# Shared helpers. Sourced by the other scripts; not meant to be run directly.
#
# Written for bash 3.2, which is what macOS ships as /bin/bash. That rules out
# associative arrays (declare -A). It also means avoiding variable names that
# collide with shell builtins - GROUPS and UID are read-only and assigning to
# them fails in confusing ways.

# Container runtime. Podman is preferred because it needs no daemon and no
# licence, but Docker works identically - both implement `compose` and `exec`.
# Override explicitly with CRI=docker (or CRI=podman) if both are installed.
#
# The install locations matter: podman's macOS pkginstaller drops the binary in
# /opt/podman/bin, which is added to PATH by a *login* shell profile only. Run
# these scripts from cron, CI, or any non-login shell and podman looks missing
# even though it is installed. Probe the usual places before giving up.
for d in /opt/podman/bin /opt/homebrew/bin /usr/local/bin \
         /Applications/Docker.app/Contents/Resources/bin; do
  case ":$PATH:" in
    *":$d:"*) ;;
    *) [ -d "$d" ] && PATH="$PATH:$d" ;;
  esac
done
export PATH

if [ -z "${CRI:-}" ]; then
  if command -v podman >/dev/null 2>&1; then
    CRI=podman
  elif command -v docker >/dev/null 2>&1; then
    CRI=docker
  else
    echo "ERROR: neither podman nor docker found." >&2
    echo "  Looked on PATH and in /opt/podman/bin, /opt/homebrew/bin, /usr/local/bin." >&2
    echo "  Install one of them - see the Prerequisites section of README.md" >&2
    exit 1
  fi
fi
KC_URL="${KC_URL:-http://localhost:8080}"
KC_MGMT="${KC_MGMT:-http://localhost:9000}"
LLDAP_URL="${LLDAP_URL:-http://localhost:17170}"
APP1_URL="${APP1_URL:-http://localhost:3001}"
APP2_URL="${APP2_URL:-http://localhost:3002}"
KC_ADMIN="${KC_ADMIN:-admin}"
KC_ADMIN_PASS="${KC_ADMIN_PASS:-admin}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
info()  { printf '  %s\n' "$*"; }

compose() { (cd "$REPO_ROOT" && $CRI compose "$@"); }

# On macOS, podman runs containers inside a VM that does not survive a reboot or
# a logout. Starting it here means the demo works from a cold Mac rather than
# failing with "Cannot connect to Podman" at the worst possible moment.
#
# Note `podman info` is NOT a usable connectivity check - it answers from
# host-side data even when the VM is down. `podman ps` actually needs the VM.
ensure_runtime() {
  if $CRI ps >/dev/null 2>&1; then
    return 0
  fi

  if [ "$CRI" = "docker" ]; then
    echo "ERROR: docker is installed but its daemon is not responding." >&2
    echo "  Start Docker Desktop (macOS/Windows), or: sudo systemctl start docker" >&2
    return 1
  fi

  # Podman on macOS runs containers inside a VM that we can start ourselves.
  # On Linux podman is daemonless, so a failure here is something else.
  if ! podman machine list >/dev/null 2>&1; then
    echo "ERROR: cannot reach podman." >&2
    return 1
  fi

  printf '  podman machine is not reachable, starting it'
  podman machine start >/dev/null 2>&1
  # A cold VM start can take well over a minute on a loaded machine; 80s was
  # observed to be too short.
  for _ in $(seq 1 90); do
    if podman ps >/dev/null 2>&1; then printf ' ready\n'; return 0; fi
    printf '.'; sleep 2
  done
  printf ' FAILED\n' >&2
  echo "  Try: podman machine start" >&2
  return 1
}

# Block until Keycloak reports ready, or give up after ~3 minutes.
wait_for_keycloak() {
  printf '  waiting for Keycloak'
  for _ in $(seq 1 60); do
    if curl -sf "$KC_MGMT/health/ready" >/dev/null 2>&1; then
      printf ' ready\n'; return 0
    fi
    printf '.'; sleep 3
  done
  printf ' TIMED OUT\n' >&2
  return 1
}

wait_for_lldap() {
  printf '  waiting for lldap'
  for _ in $(seq 1 40); do
    if curl -sf "$LLDAP_URL/health" >/dev/null 2>&1; then
      printf ' ready\n'; return 0
    fi
    printf '.'; sleep 2
  done
  printf ' TIMED OUT\n' >&2
  return 1
}

wait_for_url() { # url label
  printf '  waiting for %s' "$2"
  for _ in $(seq 1 40); do
    if curl -sf "$1" >/dev/null 2>&1; then printf ' ready\n'; return 0; fi
    printf '.'; sleep 2
  done
  printf ' TIMED OUT\n' >&2
  return 1
}

kc_token() {
  curl -s -X POST "$KC_URL/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli \
    -d "username=$KC_ADMIN" -d "password=$KC_ADMIN_PASS" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("access_token",""))'
}

kc_api() { # token method path [body]
  local tok=$1 method=$2 path=$3 body=${4:-}
  if [ -n "$body" ]; then
    curl -s -X "$method" "$KC_URL$path" -H "Authorization: Bearer $tok" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -X "$method" "$KC_URL$path" -H "Authorization: Bearer $tok"
  fi
}

print_credentials() {
  cat <<EOF

$(bold "Demo is up")

  Keycloak admin    http://localhost:8080          admin / admin
  lldap web UI      http://localhost:17170         admin / adminadmin
  App 1 (Option A)  http://localhost:3001
  App 2 (Option B)  http://localhost:3002

  Users, org-a/c/d/e   user-1 / user-1   user-2 / user-2   user-3 / user-3
  Users, org-b (LDAP)  jsmith / jsmith   afarsi / afarsi   kraman / kraman

  App 2 identity-first: sign in with an email, e.g. j.smith@orgb.example
  App 2 with a hint   : http://localhost:3002/login?org=org-b

EOF
}
