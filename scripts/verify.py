#!/usr/bin/env python3
"""
Smoke-test every path the demo claims to demonstrate. Exits non-zero on failure.

Run via scripts/verify.sh once the demo is up.
"""
import http.cookiejar
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

KC = "http://localhost:8080"
APP1 = "http://localhost:3001"
APP2 = "http://localhost:3002"
LLDAP = "http://localhost:17170"

PASSED, FAILED = [], []


def check(label, condition, detail=""):
    (PASSED if condition else FAILED).append(label)
    mark = "\033[32m✓\033[0m" if condition else "\033[31m✗\033[0m"
    print(f"  {mark} {label}" + (f"  ({detail})" if detail else ""))
    return condition


def section(title):
    print(f"\n\033[1m{title}\033[0m")


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------

class LocalhostIsSecure(http.cookiejar.DefaultCookiePolicy):
    """Keycloak marks its session cookies Secure. Browsers treat localhost as a
    secure context and send them over plain http anyway; cookiejar does not."""

    def return_ok_secure(self, cookie, request):
        return True


def new_session():
    jar = http.cookiejar.CookieJar(LocalhostIsSecure())
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    op.addheaders = [("User-Agent", "Mozilla/5.0 (verify.py)")]
    return op


def form_action(html, base):
    m = re.search(r'<form[^>]+action="([^"]+)"', html)
    return urllib.parse.urljoin(base, m.group(1).replace("&amp;", "&")) if m else None


def post_form(op, url, data):
    req = urllib.request.Request(
        url, data=urllib.parse.urlencode(data).encode(), method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    with op.open(req) as r:
        return r.geturl(), r.read().decode("utf-8", "replace")


def get(op, url):
    with op.open(url) as r:
        return r.geturl(), r.read().decode("utf-8", "replace")


def admin_token():
    body = urllib.parse.urlencode({
        "grant_type": "password", "client_id": "admin-cli",
        "username": "admin", "password": "admin"}).encode()
    with urllib.request.urlopen(
            urllib.request.Request(f"{KC}/realms/master/protocol/openid-connect/token",
                                   data=body)) as r:
        return json.load(r)["access_token"]


def api(tok, path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(KC + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {tok}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError:
        return None


def decode_jwt(token):
    p = token.split(".")[1]
    p += "=" * (-len(p) % 4)
    import base64
    return json.loads(base64.urlsafe_b64decode(p))


# --------------------------------------------------------------------------
# 1. App 1 - Option A, direct login against each tenant realm
# --------------------------------------------------------------------------

def check_app1():
    section("1. App 1 (Option A) - direct login against each tenant realm")
    creds = {"org-a": ("user-1", "user-1"), "org-b": ("jsmith", "jsmith"),
             "org-c": None,  # org-c has no local users; it federates to acme-corp
             "org-d": ("user-1", "user-1"), "org-e": ("user-1", "user-1")}
    for realm, cred in creds.items():
        if cred is None:
            print(f"  \033[33m·\033[0m {realm} skipped (no local users - federates to acme-corp)")
            continue
        user, pw = cred
        body = urllib.parse.urlencode({
            "grant_type": "password", "client_id": "app1-portal",
            "client_secret": f"app1-{realm}-secret",
            "username": user, "password": pw,
            "scope": "openid profile email"}).encode()
        try:
            with urllib.request.urlopen(urllib.request.Request(
                    f"{KC}/realms/{realm}/protocol/openid-connect/token", data=body)) as r:
                tokens = json.load(r)
            claims = decode_jwt(tokens["id_token"])
            check(f"{realm}: token issued by its own realm",
                  claims["iss"] == f"{KC}/realms/{realm}",
                  f"user={claims.get('preferred_username')} groups={claims.get('groups')}")
        except urllib.error.HTTPError as e:
            check(f"{realm}: token issued by its own realm", False, f"HTTP {e.code}")


# --------------------------------------------------------------------------
# 2-4. App 2 - Option B, brokered login through the umbrella
# --------------------------------------------------------------------------

def umbrella_login(email, username, password, via_idp=None, keep_session=False):
    """Drive the full browser flow headlessly. Returns the final profile HTML,
    or (html, opener) when keep_session is set so the caller can sign out."""
    op = new_session()
    url, html = get(op, f"{APP2}/login")
    action = form_action(html, url)
    if not action:
        return None
    url, html = post_form(op, action, {"username": email})

    # org-c's realm has no local users, so its login page offers the corporate
    # IdP as a link. Follow it rather than trying to enter credentials there.
    if via_idp:
        m = re.search(rf'href="([^"]*broker/{re.escape(via_idp)}/[^"]*)"', html)
        if m:
            url, html = get(op, urllib.parse.urljoin(url, m.group(1).replace("&amp;", "&")))

    action = form_action(html, url)
    if not action:
        return (None, op) if keep_session else None
    url, html = post_form(op, action,
                          {"username": username, "password": password, "credentialId": ""})
    if "/profile" not in url:
        url, html = get(op, f"{APP2}/profile")
    return (html, op) if keep_session else html


def check_app2(tok):
    section("2. App 2 (Option B) - identity-first routing by email domain")
    html = umbrella_login("j.smith@orgb.example", "jsmith", "jsmith")
    ok = html is not None
    check("org-b: email domain routed to the right tenant and login completed", ok)
    if not ok:
        return
    check("organization claim is org-b", "org-b" in html)
    check("shadow username is namespaced org-b.jsmith", "org-b.jsmith" in html)
    check("groups propagated from LDAP", "officers" in html)

    section("3. entra_id propagation - lldap through org-b through umbrella to App 2")
    check("entra_id arrives byte-identical (4 hops)",
          "7f3a1c88-4b2e-4d91-9c05-2e8a1f6b3d47" in html)

    section("4. Tenant isolation - the umbrella imports nobody")
    umb = {u["username"] for u in (api(tok, "/admin/realms/umbrella/users?max=100") or [])}
    orgb = {u["username"] for u in (api(tok, "/admin/realms/org-b/users?max=100") or [])}

    # Comparing raw counts is unstable: repeated runs accumulate shadow users
    # until the two sets happen to be the same size. The real claim is narrower
    # and stronger - people who never signed in have no shadow user at all.
    # `kraman` and the lldap service account `admin` are in the directory but
    # never authenticate anywhere in this suite.
    dormant = [n for n in ("kraman", "admin") if n in orgb]
    leaked = [n for n in dormant if f"org-b.{n}" in umb]

    check("directory users who never signed in have no shadow user",
          bool(dormant) and not leaked,
          f"never signed in: {dormant}; umbrella has {sorted(umb)}")
    check("every umbrella user is a namespaced shadow identity",
          all(n.startswith("org-") for n in umb) if umb else False,
          "a bulk import would show raw directory usernames here")


# --------------------------------------------------------------------------
# 5. Sync mode FORCE - a changed source value must re-propagate
# --------------------------------------------------------------------------

def lldap_token():
    body = json.dumps({"username": "admin", "password": "adminadmin"}).encode()
    req = urllib.request.Request(f"{LLDAP}/auth/simple/login", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)["token"]


def set_lldap_entra_id(tok, user, value):
    q = {"query": "mutation U($user: UpdateUserInput!) { updateUser(user: $user) { ok } }",
         "variables": {"user": {"id": user,
                                "insertAttributes": [{"name": "entra-id", "value": [value]}]}}}
    req = urllib.request.Request(f"{LLDAP}/api/graphql", data=json.dumps(q).encode(),
                                 headers={"Authorization": f"Bearer {tok}",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def check_force_sync():
    section("5. Sync mode FORCE - changing entra_id in lldap re-propagates")
    original = "7f3a1c88-4b2e-4d91-9c05-2e8a1f6b3d47"
    changed = "99999999-dead-4beef-8888-999999999999"
    lt = lldap_token()
    try:
        set_lldap_entra_id(lt, "jsmith", changed)
        html = umbrella_login("j.smith@orgb.example", "jsmith", "jsmith")
        check("changed value reaches App 2 on the next login",
              html is not None and changed in html,
              "an IdP mapper left on the default IMPORT sync mode fails here")
    finally:
        set_lldap_entra_id(lt, "jsmith", original)


# --------------------------------------------------------------------------
# 6. org-c - chained brokering, six hops
# --------------------------------------------------------------------------

def check_org_c():
    section("6. org-c - chained brokering through a corporate IdP")
    html = umbrella_login("user-1@orgc.example", "user-1", "user-1", via_idp="acme-corp")
    ok = html is not None and "org-c" in html
    check("acme-corp-idp -> org-c -> umbrella -> App 2 completes", ok)
    if ok:
        check("entra_id survived two brokering hops",
              "c1000000-aaaa-4bbb-8ccc-000000000001" in html)
        check("shadow username chained (org-c.acme.user-1)", "org-c.acme.user-1" in html)


# --------------------------------------------------------------------------
# 7. Sign-out actually ends the Keycloak session
# --------------------------------------------------------------------------

def client_session_count(tok, realm, client_id):
    cs = api(tok, f"/admin/realms/{realm}/clients?clientId={client_id}") or []
    if not cs:
        return -1
    r = api(tok, f"/admin/realms/{realm}/clients/{cs[0]['id']}/session-count") or {}
    return r.get("count", -1)


def check_logout(tok):
    section("7. Signing out ends the Keycloak session, not just the app cookie")
    html, op = umbrella_login("j.smith@orgb.example", "jsmith", "jsmith", keep_session=True)
    if not check("signed in before testing logout", html is not None):
        return

    hub_before = client_session_count(tok, "umbrella", "app2-portal")
    spoke_before = client_session_count(tok, "org-b", "umbrella-broker")

    post_form(op, f"{APP2}/logout", {})

    hub_after = client_session_count(tok, "umbrella", "app2-portal")
    spoke_after = client_session_count(tok, "org-b", "umbrella-broker")

    # Other sessions may exist, so assert the delta rather than an absolute zero.
    check("logout ends the hub session", hub_after == hub_before - 1,
          f"umbrella {hub_before} -> {hub_after}")
    check("logout propagates to the organisation realm", spoke_after == spoke_before - 1,
          f"org-b {spoke_before} -> {spoke_after}")

    # The regression that prompted this check: clearing only the app cookie left
    # Keycloak's SSO session alive, so the next login silently skipped the
    # password prompt and walked straight back into the app.
    url, html2 = get(op, f"{APP2}/login")
    check("next sign-in asks for credentials again",
          "/profile" not in url and 'name="username"' in html2,
          "a local-session-only logout would land straight on /profile")


# --------------------------------------------------------------------------
# 8. add-org.sh - onboarding a tenant without touching App 2
# --------------------------------------------------------------------------

def check_add_org(tok, repo_root):
    section("8. Onboarding a new tenant without restarting App 2")
    subprocess.run([f"{repo_root}/scripts/add-org.sh", "org-f"],
                   capture_output=True, text=True)
    try:
        html = umbrella_login("user-1@orgf.example", "user-1", "user-1")
        check("a brand new tenant can sign in, App 2 untouched",
              html is not None and "org-f" in html)
    finally:
        api(tok, "/admin/realms/org-f", method="DELETE")
        orgs = api(tok, "/admin/realms/umbrella/organizations") or []
        for o in orgs:
            if o.get("alias") == "org-f":
                api(tok, f"/admin/realms/umbrella/organizations/{o['id']}", method="DELETE")
        api(tok, "/admin/realms/umbrella/identity-provider/instances/org-f", method="DELETE")
        print("  · cleaned up org-f")


# --------------------------------------------------------------------------

def main():
    repo_root = sys.argv[1] if len(sys.argv) > 1 else "."
    try:
        tok = admin_token()
    except Exception as e:
        print(f"Cannot reach Keycloak at {KC}: {e}", file=sys.stderr)
        return 2

    check_app1()
    check_app2(tok)
    check_force_sync()
    check_org_c()
    check_logout(tok)
    check_add_org(tok, repo_root)

    print(f"\n\033[1m{len(PASSED)} passed, {len(FAILED)} failed\033[0m")
    if FAILED:
        for f in FAILED:
            print(f"  \033[31mFAILED\033[0m {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
