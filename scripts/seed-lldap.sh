#!/usr/bin/env bash
#
# Seed lldap with org-b's directory: a custom entra-id attribute, two groups and
# three users whose usernames deliberately look nothing like their email
# addresses. Idempotent — safe to re-run.
#
# Two lldap constraints drive the odd bits below:
#   * attribute names allow only a-z A-Z 0-9 and dash, so the LDAP attribute is
#     "entra-id" while Keycloak maps it to the user attribute "entra_id"
#   * passwords must be 8+ characters, so password==username needs
#     lldap_set_password --bypass-password-policy
#
set -uo pipefail

# Sourced for the shared container-runtime detection (podman or docker).
. "$(dirname "$0")/lib.sh"

LLDAP_ADMIN="${LLDAP_ADMIN:-admin}"
LLDAP_PASS="${LLDAP_PASS:-adminadmin}"
LLDAP_CONTAINER="${LLDAP_CONTAINER:-kc-demo-lldap}"

# username | display | first | last | email | entra-id | groups(csv)
USERS=(
  "jsmith|John Smith|John|Smith|j.smith@orgb.example|7f3a1c88-4b2e-4d91-9c05-2e8a1f6b3d47|officers"
  "afarsi|Amina Farsi|Amina|Farsi|a.farsi@orgb.example|b2d94e11-8c37-4a60-91ef-5d7c02a48b93|officers,admins"
  "kraman|Kamal Raman|Kamal|Raman|k.raman@orgb.example|3e6f0a72-15d8-4c29-b843-9a1e7f2c60d5|officers"
)
GROUP_NAMES=(officers admins)

say() { printf '  %s\n' "$*"; }

# --- wait for lldap ---------------------------------------------------------
for _ in $(seq 1 40); do
  curl -sf "$LLDAP_URL/health" >/dev/null 2>&1 && break
  sleep 1
done

TOKEN=$(curl -s -X POST "$LLDAP_URL/auth/simple/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$LLDAP_ADMIN\",\"password\":\"$LLDAP_PASS\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')

if [ -z "$TOKEN" ]; then
  echo "ERROR: could not authenticate to lldap at $LLDAP_URL" >&2
  exit 1
fi

gql() {
  curl -s -X POST "$LLDAP_URL/api/graphql" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1"
}

echo "Seeding lldap at $LLDAP_URL"

# --- custom attribute -------------------------------------------------------
# lldap forbids underscores in attribute names, hence entra-id not entra_id.
gql '{"query":"mutation { addUserAttribute(name:\"entra-id\", attributeType: STRING, isList:false, isVisible:true, isEditable:true) { ok } }"}' >/dev/null
say "attribute entra-id ready"

# --- groups -----------------------------------------------------------------
# No associative arrays here: macOS ships bash 3.2, where `declare -A` does not
# exist. Group ids are looked up from the cached JSON on demand instead.
for g in "${GROUP_NAMES[@]}"; do
  gql "{\"query\":\"mutation { createGroup(name:\\\"$g\\\") { id } }\"}" >/dev/null
done

GROUPS_JSON=$(gql '{"query":"{ groups { id displayName } }"}')

group_id_of() {
  printf '%s' "$GROUPS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']['groups']
print(next((str(x['id']) for x in d if x['displayName'] == '$1'), ''))"
}

for g in "${GROUP_NAMES[@]}"; do
  say "group $g -> id $(group_id_of "$g")"
done

# --- users ------------------------------------------------------------------
for row in "${USERS[@]}"; do
  IFS='|' read -r uid display first last email entra groups <<<"$row"

  payload=$(python3 -c "
import json, sys
print(json.dumps({
  'query': 'mutation CreateUser(\$user: CreateUserInput!) { createUser(user: \$user) { id } }',
  'variables': {'user': {
     'id': '$uid', 'email': '$email', 'displayName': '$display',
     'firstName': '$first', 'lastName': '$last',
     'attributes': [{'name': 'entra-id', 'value': ['$entra']}],
  }},
}))")
  gql "$payload" >/dev/null

  # Password equals username. lldap enforces 8 chars unless we bypass.
  "$CRI" exec "$LLDAP_CONTAINER" /app/lldap_set_password \
    --base-url http://localhost:17170 \
    --admin-username "$LLDAP_ADMIN" --admin-password "$LLDAP_PASS" \
    --username "$uid" --password "$uid" --bypass-password-policy >/dev/null 2>&1

  IFS=',' read -ra gs <<<"$groups"
  for g in "${gs[@]}"; do
    gid=$(group_id_of "$g")
    [ -n "$gid" ] && gql "{\"query\":\"mutation { addUserToGroup(userId:\\\"$uid\\\", groupId:$gid) { ok } }\"}" >/dev/null
  done

  say "user $uid ($email) groups=$groups"
done

echo "lldap seeded. Web UI: $LLDAP_URL  ($LLDAP_ADMIN / $LLDAP_PASS)"
