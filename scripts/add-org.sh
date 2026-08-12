#!/usr/bin/env bash
#
# Onboard a new tenant, live. This is the demo's closing argument.
#
#   ./scripts/add-org.sh org-f
#
# Creates the tenant realm (clients, groups, three users), registers it as an
# identity provider on the umbrella, wires the mappers, and creates the matching
# Organization with its email domain.
#
# App 2 is never touched. It is not restarted, reconfigured or redeployed, and
# a user from the new tenant can sign in immediately. Doing the same under
# Option A means a new client, a new secret, an App 1 config change and a
# redeploy - which is the whole point of the comparison.
#
set -uo pipefail
. "$(dirname "$0")/lib.sh"

ORG="${1:-}"
if [ -z "$ORG" ]; then
  echo "usage: $0 <org-name>    e.g. $0 org-f" >&2
  exit 1
fi

TOKEN=$(kc_token)
if [ -z "$TOKEN" ]; then
  echo "ERROR: could not get a Keycloak admin token. Is the demo running?" >&2
  exit 1
fi

bold "Onboarding $ORG"

ORG="$ORG" KC_URL="$KC_URL" TOKEN="$TOKEN" python3 <<'PY'
import json, os, sys, urllib.error, urllib.request

ORG   = os.environ['ORG']
KC    = os.environ['KC_URL']
TOKEN = os.environ['TOKEN']

# org-f -> "f" -> orgf.example ; falls back to a safe slug for odd names.
suffix = ORG.split('-', 1)[1] if '-' in ORG else ORG
DOMAIN = f"org{suffix}.example".replace('_', '')
LABEL  = ORG.replace('-', '-').title()

def call(method, path, body=None, quiet=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(KC + path, data=data, method=method,
                                 headers={'Authorization': f'Bearer {TOKEN}',
                                          'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        if not quiet:
            print(f"  ! {method} {path} -> {e.code} {e.read()[:200].decode(errors='replace')}")
        return e.code, None

groups_mapper = {
    "name": "groups", "protocol": "openid-connect",
    "protocolMapper": "oidc-group-membership-mapper",
    "config": {"full.path": "false", "id.token.claim": "true",
               "access.token.claim": "true", "userinfo.token.claim": "true",
               "claim.name": "groups"},
}

def user(n, group):
    return {
        "username": f"user-{n}", "enabled": True, "emailVerified": True,
        "email": f"user-{n}@{DOMAIN}", "firstName": "User", "lastName": str(n),
        "credentials": [{"type": "password", "value": f"user-{n}", "temporary": False}],
        "groups": [group],
    }

# --- 1. the tenant realm ----------------------------------------------------
realm = {
    "realm": ORG, "enabled": True, "displayName": LABEL,
    "displayNameHtml": f'<div class="kc-logo-text"><span>{LABEL}</span></div>',
    "sslRequired": "none", "registrationAllowed": False,
    "loginWithEmailAllowed": True, "duplicateEmailsAllowed": False,
    "groups": [{"name": "officers"}, {"name": "admins"}],
    "clients": [
        {"clientId": "app1-portal", "enabled": True, "protocol": "openid-connect",
         "publicClient": False, "secret": f"app1-{ORG}-secret",
         "standardFlowEnabled": True, "directAccessGrantsEnabled": True,
         "redirectUris": ["http://localhost:3001/*"],
         "webOrigins": ["http://localhost:3001"],
         "attributes": {"pkce.code.challenge.method": "S256"},
         "protocolMappers": [groups_mapper]},
        {"clientId": "umbrella-broker", "enabled": True, "protocol": "openid-connect",
         "publicClient": False, "secret": f"broker-{ORG}-secret",
         "standardFlowEnabled": True,
         "redirectUris": [f"http://localhost:8080/realms/umbrella/broker/{ORG}/endpoint",
                          f"http://localhost:8080/realms/umbrella/broker/{ORG}/endpoint/*"],
         "protocolMappers": [groups_mapper]},
    ],
    "users": [user(1, "/officers"), user(2, "/officers"), user(3, "/admins")],
}

status, _ = call('POST', '/admin/realms', realm)
if status == 409:
    print(f"  realm {ORG} already exists - continuing")
elif status not in (201, 204):
    sys.exit(f"  failed to create realm {ORG}")
else:
    print(f"  realm {ORG} created with 3 users")

# --- 2. register it as an IdP on the umbrella -------------------------------
base = f"{KC}/realms/{ORG}/protocol/openid-connect"
idp = {
    "alias": ORG, "displayName": LABEL, "providerId": "oidc", "enabled": True,
    "trustEmail": True, "firstBrokerLoginFlowAlias": "first broker login",
    "config": {
        "clientId": "umbrella-broker", "clientSecret": f"broker-{ORG}-secret",
        "authorizationUrl": f"{base}/auth", "tokenUrl": f"{base}/token",
        "jwksUrl": f"{base}/certs", "userInfoUrl": f"{base}/userinfo",
        "logoutUrl": f"{base}/logout", "issuer": f"{KC}/realms/{ORG}",
        "useJwksUrl": "true", "clientAuthMethod": "client_secret_post",
        "defaultScope": "openid profile email",
        "syncMode": "FORCE", "hideOnLoginPage": "false",
        "kc.org.domain": DOMAIN,
        "kc.org.broker.redirect.mode.email-matches": "true",
    },
}
call('POST', '/admin/realms/umbrella/identity-provider/instances', idp, quiet=True)
print(f"  identity provider {ORG} registered on umbrella")

# --- 3. mappers: namespace the shadow username, carry groups ----------------
mappers = [
    {"name": f"{ORG}-username-template", "identityProviderAlias": ORG,
     "identityProviderMapper": "oidc-username-idp-mapper",
     "config": {"template": "${ALIAS}.${CLAIM.preferred_username}",
                "target": "LOCAL", "syncMode": "INHERIT"}},
    {"name": f"{ORG}-entra-id", "identityProviderAlias": ORG,
     "identityProviderMapper": "oidc-user-attribute-idp-mapper",
     "config": {"claim": "entra_id", "user.attribute": "entra_id", "syncMode": "FORCE"}},
]
for g in ("officers", "admins"):
    mappers.append({
        "name": f"{ORG}-group-{g}", "identityProviderAlias": ORG,
        "identityProviderMapper": "oidc-advanced-group-idp-mapper",
        "config": {"claims": json.dumps([{"key": "groups", "value": g}]),
                   "group": f"/{g}", "are.claim.values.regex": "false",
                   "syncMode": "FORCE"},
    })
for m in mappers:
    call('POST', f'/admin/realms/umbrella/identity-provider/instances/{ORG}/mappers', m, quiet=True)
print(f"  {len(mappers)} identity provider mappers wired")

# --- 4. the Organization, linked to that IdP --------------------------------
call('POST', '/admin/realms/umbrella/organizations', {
    "name": ORG, "alias": ORG, "enabled": True,
    "description": f"Tenant {LABEL}",
    "domains": [{"name": DOMAIN, "verified": True}],
}, quiet=True)

_, orgs = call('GET', '/admin/realms/umbrella/organizations')
oid = next((o['id'] for o in (orgs or []) if o.get('alias') == ORG), None)
if oid:
    call('POST', f'/admin/realms/umbrella/organizations/{oid}/identity-providers', ORG, quiet=True)
    _, linked = call('GET', f'/admin/realms/umbrella/organizations/{oid}/identity-providers')
    print(f"  organization {ORG} ({DOMAIN}) linked to idps "
          f"{[i.get('alias') for i in (linked or [])]}")
else:
    sys.exit("  failed to create the organization")

print()
print(f"  Done. Sign in at http://localhost:3002 as user-1@{DOMAIN} / user-1")
print("  App 2 was not restarted, reconfigured or redeployed.")
PY
