# Keycloak multi-realm management demo

Two sample applications, five organisations, one local Keycloak — built to answer
a single architectural question you can log into rather than argue about.

**Get it running:**

```bash
./scripts/start-all.sh
```

Then open <http://localhost:3002> and sign in as `j.smith@orgb.example` / `jsmith`.

---

## 1 · The problem

An application has to authenticate users belonging to **several independent
organisations**. Each organisation:

- is **administered by its own org admin**, who adds and removes users whenever
  they like — nobody centrally knows when a new user appears
- keeps its users in **its own identity source**: a local user store, a corporate
  LDAP or Active Directory, or its own external OIDC provider
- has **its own login flow**, password policy, MFA rules and branding
- may sit on an **entirely separate identity provider setup**

In Keycloak, each organisation naturally maps to its own **realm**. Realms are
isolated from one another by design, which is what makes delegated administration
and per-organisation federation possible in the first place.

That leaves one open question, and it is the question this repo exists to answer:

> **How should applications connect to many independently-managed realms?**

### Why realms, and not just Keycloak Organizations?

Keycloak 26 ships an **Organizations** feature, and at first glance it looks like
it already solves this: inside a *single* realm you can define many
organisations, give each its own email domain and its own identity provider, and
have users routed to the right one at login. It is a genuinely good fit for
multi-tenancy — and this demo uses it, because the umbrella hub realm is exactly
that.

What Organizations do **not** give you is **delegated administration**.
Administrative roles in Keycloak are realm-scoped: `manage-organizations` lets
whoever holds it manage *every* organisation in that realm, and there is no role
that grants "administrator of Org-B only". A single-realm, many-organisations
setup therefore has exactly **one set of realm admins**.

So the deciding factor is organisational, not technical:

| If… | then |
|---|---|
| organisations are a way to **group and route** users that one central team administers | **one realm with Organizations** — simpler, scales further |
| **each organisation's own admin** must manage their own users, groups, federation and login policy without touching anyone else's | the boundary must be a **realm** — the realm *is* Keycloak's administrative and isolation boundary |

This demo assumes the second case, and uses both concepts for different jobs:
**realms provide the delegation and isolation boundary**, while **Organizations
inside the umbrella hub** provide the grouping and email-domain routing that let
a single client serve all of them.

---

## 2 · The two options

| | **Option A — Direct** | **Option B — Umbrella** |
|---|---|---|
| Shape | the app talks to every organisation's realm directly | a hub realm brokers to each organisation's realm |
| The app holds | one confidential client **per organisation** | **one** confidential client, total |
| Tenant knowledge in the app | every organisation, hardcoded | none |
| Choosing the organisation | a dropdown in the app | Keycloak matches the user's email domain |
| Adding an organisation | new client, new secret, config change, redeploy | a Keycloak change only |
| Isolation | absolute — nothing shared | strong, but the hub keeps a linked shadow identity |

**App 1** (<http://localhost:3001>) implements Option A.
**App 2** (<http://localhost:3002>) implements Option B.

Both authenticate the *same five organisations*, so you can sign in as the same
person through each and compare what comes back.

---

## 3 · What you need

**A container runtime — podman or docker. That is the only thing you have to
install.**

The scripts auto-detect whichever is present, preferring podman. Force a choice
with `CRI=podman` or `CRI=docker` if you have both.

<details>
<summary><b>Installing podman</b> (default — no daemon, no licence)</summary>

```bash
# macOS
brew install podman
podman machine init --memory 4096 --cpus 4
podman machine start

# Fedora / RHEL
sudo dnf install -y podman podman-compose

# Debian / Ubuntu
sudo apt install -y podman podman-compose
```

On macOS podman runs containers in a VM. **Give it 4 GB** — the 2 GB default gets
OOM-killed when Keycloak starts, which looks like the runtime vanishing
mid-command. For a machine that already exists:

```bash
podman machine stop && podman machine set --memory 4096 && podman machine start
```

The start scripts bring the VM up themselves if it is stopped, so a fresh reboot
needs no manual step.
</details>

<details>
<summary><b>Installing docker</b></summary>

```bash
# macOS / Windows
brew install --cask docker      # then launch Docker Desktop once

# Debian / Ubuntu
sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker "$USER"   # log out and back in
```

Needs **Compose v2** (`docker compose`). Give Docker Desktop at least 4 GB under
Settings → Resources. Then:

```bash
CRI=docker ./scripts/start-all.sh
```
</details>

Everything else the scripts use — `bash`, `curl`, `python3` — ships with macOS
and every mainstream Linux. No Node.js, Java or Maven on the host; the apps build
inside containers. Ports used: `8080`, `9000`, `3001`, `3002`, `3890`, `17170`.

---

## 4 · Run it

```bash
./scripts/start-all.sh     # start everything, prints the credential sheet
./scripts/verify.sh        # prove all 20 assertions pass
./scripts/status.sh        # one-screen health check
./scripts/reset.sh         # wipe and rebuild from scratch
./scripts/stop-all.sh      # stop
```

### Running components separately, and watching their logs

`start-all.sh` launches everything **detached**, so nothing prints to your
terminal after the credential sheet. That is fine until something misbehaves —
at which point you want to see what a component is actually doing.

Each component has its own start script, and each accepts **`-f`** to attach to
its logs after starting:

```bash
./scripts/start-kc.sh -f      # Keycloak + lldap, then follow their logs
./scripts/start-app1.sh -f    # App 1, then follow its log
./scripts/start-app2.sh -f    # App 2, then follow its log
```

`Ctrl-C` stops watching; the container keeps running.

**To watch more than one component, do not use `-f`** — it attaches and blocks
the shell. Start them normally, then follow whichever set you want:

```bash
./scripts/start-all.sh                 # everything, detached
./scripts/logs.sh keycloak app2        # follow just those two, interleaved
```

```bash
./scripts/logs.sh                      # all four
./scripts/logs.sh keycloak             # one
./scripts/logs.sh app2 --tail 500      # last 500 lines, then follow
./scripts/logs.sh --no-follow          # dump and exit
```

Each stream is colour-coded and prefixed, so one terminal is enough:

```
app2     │ GET /login
keycloak │ LOGIN realmName="org-b" clientId="umbrella-broker" username="jsmith"
keycloak │ CODE_TO_TOKEN realmName="org-b"
keycloak │ IDENTITY_PROVIDER_FIRST_LOGIN realmName="umbrella" identity_provider="org-b"
keycloak │ REGISTER realmName="umbrella" register_method="broker" username="org-b.jsmith"
app2     │ GET /callback {"state":"…","code":"…"}
app2     │   back-channel token exchange -> 200
keycloak │ CODE_TO_TOKEN realmName="umbrella" scope="… organization"
app2     │ GET /profile
```

That is a single sign-in narrating itself. The `REGISTER … register_method="broker"`
line **is** the shadow user being created — JIT provisioning, live, with no
administrator involved. Running `logs.sh keycloak app2` on a second screen while
you walk through [section 5](#5--the-walkthrough) makes the argument twice.

> Keycloak logs nothing useful at `info` for a successful login, so
> `compose.yml` raises `org.keycloak.events` to `debug`. Every authentication
> decision then appears with a reason, which is what makes a failed login
> diagnosable rather than mysterious.

### Credentials

Memorable on purpose. None of it is safe anywhere real.

| What | URL | Login |
|---|---|---|
| Keycloak admin console | <http://localhost:8080> | `admin` / `admin` |
| lldap web UI | <http://localhost:17170> | `admin` / `adminadmin` |
| App 1 — Option A | <http://localhost:3001> | — |
| App 2 — Option B | <http://localhost:3002> | — |

| Organisation | Users | Password |
|---|---|---|
| org-a, org-c, org-d, org-e | `user-1`, `user-2`, `user-3` | same as the username |
| **org-b** (LDAP) | `jsmith`, `afarsi`, `kraman` | same as the username |

Client secrets are readable literals like `app1-org-a-secret`, so the credential
sprawl is visible on screen rather than hidden behind UUIDs.

> lldap enforces a minimum password length of 8, which is why *its* admin
> password is `adminadmin`. Demo users get under that floor via
> `lldap_set_password --bypass-password-policy`.

### The five organisations

Deliberately not alike, so each one makes a different point:

| Realm | Identity source | What it shows |
|---|---|---|
| `org-a` | local Keycloak users | the simple baseline |
| `org-b` | **LDAP** (lldap container) | a real corporate directory, with usernames that are not emails |
| `org-c` | **OIDC** brokering to `acme-corp-idp` | an organisation on someone else's identity provider |
| `org-d` | local users + own password policy | per-organisation policy divergence |
| `org-e` | local users | a second plain one, for fast logins |

Plus `umbrella` (the hub) and `acme-corp-idp` (org-c's stand-in external
provider) — seven realms in total.

```
   App 1 :3001  ──┬──▶ org-a   local users
   5 clients      ├──▶ org-b   LDAP ──▶ lldap :3890
   5 secrets      ├──▶ org-c   OIDC ──▶ acme-corp-idp realm
   dropdown       ├──▶ org-d   local users + own policy
                  └──▶ org-e   local users
                          │
                          │  OIDC brokering · shadow users created on first login
                          ▼
   App 2 :3002  ──▶  umbrella   5 IdPs · 5 Organizations · 1 client
   no tenant
   knowledge
```

For convenience everything runs as separate realms on **one** local Keycloak.
Realms are independent token issuers, so this behaves the same as organisations
living on genuinely separate infrastructure — it just fits on a laptop.

---

## 5 · The walkthrough

About fifteen minutes. Each step has what to do, then what it shows. Start from a
clean slate with `./scripts/reset.sh`, and keep four tabs open: App 1, App 2, the
Keycloak admin console and the lldap web UI.

### Step 1 — Option A, and what it costs

**Do:** App 1 → choose **Org-A** → sign in as `user-1` / `user-1`.

**Shows:** the app talks straight to that organisation's realm. It works, it is
simple, and the isolation is absolute. Look at the table on App 1's home page:
five realms, five clients, **five secrets**. At 150 organisations that is 150.

### Step 2 — an organisation with a real directory

**Do:** App 1 → choose **Org-B** → sign in as `jsmith` / `jsmith`.

**Shows:** the username is `jsmith`, the email is `j.smith@orgb.example`. Real
directories rarely use email addresses as usernames, and Keycloak's LDAP
federation points a *"Username LDAP attribute"* setting at whatever each
directory actually uses. Every organisation chooses independently.

**Then:** Keycloak admin → realm **org-b** → Users → *Search*. The realm lists the
whole directory. Hold that thought — step 4 depends on it.

### Step 3 — Option B, and an app that knows nothing

**Do:** App 2 → **Sign in**. There is no dropdown, just one email box. Type
`j.smith@orgb.example`.

**Shows:** App 2 sent no tenant hint at all. Keycloak matched the email domain to
an Organization and routed to Org-B's realm on its own. Credentials were entered
against Org-B, never against the umbrella.

The profile page annotates every claim with where it came from. One client, one
secret, zero tenants hardcoded.

**Optional:** `/login?org=org-b` sends `kc_idp_hint` instead, for the case where a
tenant subdomain already identified the organisation.

### Step 4 — does the hub import everybody?

The question any security review will ask.

**Do:** Keycloak admin → realm **umbrella** → Users → *Search*.

**Shows: one user.** `org-b.jsmith` — the only person who has actually signed in.
Compare with step 2, where Org-B's realm listed the entire directory.

The umbrella holds an *OIDC identity provider*, not a directory, and OIDC has no
"list users" operation. There is no mechanism by which a bulk import could happen,
even by accident. Shadow users appear one at a time, when a real person signs in.

Note the username: `org-b.jsmith`, not `jsmith` — namespaced by the Username
Template Importer, so `user-1` can exist in all five organisations without ever
colliding here. Open the user → **Identity provider links** → one link back to
Org-B. The umbrella never holds their password.

> **The one anti-pattern that breaks this:** never give the *umbrella* an LDAP
> User Federation provider pointing at an organisation's directory. The umbrella
> speaks OIDC to spokes and nothing else.

### Step 5 — follow a directory identifier

**Do:** lldap web UI → user `jsmith` → look at the `entra-id` attribute. Then App
2's profile page → the `entra_id` claim.

**Shows:** the same value, four hops apart — lldap → Org-B's realm → the
umbrella's shadow user → App 2's token. That identifier is the join key that lets
an application record be traced back to an organisation's own directory entry,
which is what turns a shadow user from a degraded copy into a faithful
projection.

For org-c the same value makes six hops through two brokering layers, and the
shadow username chains to `org-c.acme.user-1`.

### Step 6 — nothing goes stale

**Do:** in lldap, change `jsmith`'s `entra-id` to anything. Save. Then App 2 →
sign out → sign in again.

**Shows:** the new value. Every identity provider mapper runs in **sync mode
FORCE**, so claims are re-applied on every login rather than only the first. The
organisation's own directory stays authoritative and nothing was re-imported.

Same trick with groups: move `jsmith` into `admins` in lldap, sign in again, watch
the `groups` claim change.

### Step 7 — onboarding organisation number 151

**Do:**

```bash
./scripts/add-org.sh org-f
```

Then App 2 → sign in as `user-1@orgf.example` / `user-1`.

**Shows:** an organisation that did not exist ninety seconds ago. **App 2 was not
restarted, reconfigured or redeployed** — it still holds one secret and still
knows about zero tenants.

The same onboarding under Option A means registering a client in the new realm,
issuing a secret, adding both to the application's configuration, and shipping a
release. That difference, multiplied by every organisation and then by every
future policy change, is the real operational cost of Option A.

### Step 8 — the close

Everything you have just seen is **declarative Keycloak configuration** — seven
realm JSON files. No custom SPI, no plugins, no custom server build.

It also uses **no token exchange**, so none of the v1/v2 deprecation churn in that
area applies. Identity brokering has been core since Keycloak 1.x, and
Organizations is supported and enabled by default. As dependency surfaces go, that
is about as conservative as it gets.

---

## 6 · Questions you will get asked

**"Could the hub accidentally sync our whole directory?"**
No — it holds an OIDC identity provider, which cannot enumerate users. The only
thing to prohibit is giving the *umbrella* an LDAP User Federation provider
pointing at an organisation's directory.

**"What if two organisations have a user with the same username?"**
Shown in step 4. Shadow usernames are namespaced per identity provider as
`<org>.<username>`, so `user-1` can exist in all five organisations at once.

**"What if two users in two different organisations have the same *email*?"**

In the organisations' own realms: nothing at all. Realms are isolated, both
users exist happily, and Option A never notices — App 1 talks to each realm
directly.

In the umbrella it cannot happen, because Keycloak Organizations enforces two
independent rules. Verified against 26.7.1:

1. **Domains are unique within a realm.** Trying to give a second organisation a
   domain another one already holds is rejected outright:
   `Domain orga.example is already linked to organization org-a in realm umbrella`
2. **A member's email must match their own organisation's domain.** A user
   brokered in from org-e carrying an `@orga.example` address is stopped at the
   *Update Account Information* screen with
   `Email domain does not match any domain from the organization`, and cannot
   complete the login until the address is corrected.

Together those make an email shared across two organisations unreachable — which
matters, because without them the second arrival would hit First Broker Login's
*existing account* path and be offered the chance to **link** the two identities,
quietly merging two different people from two different organisations into one
umbrella account.

> **The guard is the domain.** An Organization can be created with no domains at
> all, and then rule 2 has nothing to enforce. If you route purely by
> `kc_idp_hint` and skip domains, restore the protection by setting
> `duplicateEmailsAllowed: false` (as this demo does) and reviewing the *Detect
> existing broker user* step in the First Broker Login flow.

**"The hub stores a copy of our users — what about isolation?"**
It stores a linked shadow identity: username, email, group claims and the
directory identifier from step 5. **No credentials.** Authentication always
happens in the organisation's own realm against its own directory.

**"Can each organisation keep its own MFA and password policy?"**
Yes — those live in each organisation's realm. Org-D carries its own password
policy and brute-force settings to show the divergence.

**"Does any of this need custom code?"**
No. That is the point of step 8.

**"Why not put everything in one realm with Organizations?"**
See [section 1](#why-realms-and-not-just-keycloak-organizations) — it comes down
to whether each organisation needs its own administrators.

---

## 7 · How it is built

```
.env                        component versions - change and re-run reset.sh
compose.yml                 keycloak · lldap · app1 · app2
keycloak/realms/*.json      all 7 realms, imported at startup
apps/app1-direct/           Express BFF, 5 confidential clients
apps/app2-umbrella/         Express BFF, 1 confidential client
scripts/                    start / stop / reset / verify / add-org
```

Both apps follow the **backend-for-frontend** pattern: the client secret and the
authorization code verifier stay server-side, and Keycloak tokens never reach the
browser. The OIDC flow is hand-rolled rather than pulled from a library so the
redirects and the back-channel token call are readable.

`server.js` is bind-mounted, so editing an app needs only a restart:

```bash
podman restart kc-demo-app2
```

### Changing versions

Everything version-pinned lives in [`.env`](.env):

```bash
KEYCLOAK_VERSION=26.7.1
LLDAP_VERSION=2026-08-10
NODE_VERSION=22-alpine
```

Edit a line, then `./scripts/reset.sh`. To try the Red Hat build of Keycloak, set
`KEYCLOAK_IMAGE=registry.redhat.io/rhbk/keycloak-rhel9` and
`KEYCLOAK_VERSION=26.6` after `podman login registry.redhat.io`. Organizations,
brokering and the mappers behave identically.

### Editing realm config

Keycloak's `start-dev` uses a **file-backed** H2 database, and `--import-realm`
skips realms that already exist. Editing a realm JSON and restarting the container
therefore changes nothing:

```bash
./scripts/reset.sh     # the only way to re-import
```

### Scripts

| Script | What it does |
|---|---|
| `start-all.sh` | everything, in order, then prints the credential sheet |
| `start-kc.sh [-f]` | Keycloak + lldap, then seeds the org-b directory |
| `start-app1.sh [-f]` / `start-app2.sh [-f]` | one app at a time |
| **`logs.sh [service]`** | **follow logs — all, or one of `keycloak` `lldap` `app1` `app2`** |
| **`status.sh`** | **one-screen health check: runtime, containers, endpoints, realms, users** |
| `stop-all.sh` | stop containers, keep the lldap volume |
| `reset.sh` | full wipe and re-import |
| `verify.sh` | 20 assertions covering every path; non-zero exit on failure |
| `add-org.sh <name>` | onboards a whole new organisation live |
| `seed-lldap.sh` | seeds lldap; idempotent, called by `start-kc.sh` |

`-f` on a start script attaches to that component's logs once it is up.

---

## 8 · Troubleshooting

**Start here, in this order:**

```bash
./scripts/status.sh          # which layer is broken?
./scripts/logs.sh keycloak   # what is it actually saying?
```

`status.sh` walks the stack from the bottom up — container runtime, containers,
HTTP endpoints, the seven realms, then user counts — and stops at the first thing
that is wrong. That usually tells you which log to read, rather than making you
guess.

Once you know the component, follow its log while you reproduce the problem:

```bash
./scripts/logs.sh app2       # or keycloak · lldap · app1
```

Keycloak logs every authentication decision, so a failing login shows up there
with a reason. App logs show the redirect and the back-channel token call.

---

**"Cannot connect to Podman" / docker daemon errors**
The scripts start podman's VM themselves. They cannot start Docker Desktop for
you — launch it, then re-run.

**Keycloak dies during startup, or the runtime vanishes mid-command**
The podman machine is out of memory. It needs 4 GB; see
[section 3](#3--what-you-need).

**Realm JSON edits appear to do nothing**
Use `./scripts/reset.sh`, not a container restart — see *Editing realm config*.

**Ports already in use**
`8080`, `9000`, `3001`, `3002`, `3890`, `17170`. Stop the conflicting service or
edit `compose.yml`.

**A login loops or errors after changing config**
Clear the Keycloak session: visit
`http://localhost:8080/realms/umbrella/protocol/openid-connect/logout`, or just
run `./scripts/reset.sh`.

### Notes and gotchas

Things that cost real debugging time, recorded so they do not cost it twice.

- **Organizations are per-realm.** `organizationsEnabled: true` is required in the
  realm JSON; creating an Organization without it returns `404`.
- **Realm import does carry Organizations** and the IdP↔Organization link, via
  `organizations[].identityProviders[{alias}]`. No provisioning script needed.
- **`kc.org.broker.redirect.mode.email-matches`** must be set per IdP. Without it,
  a first-time user typing a matching email gets an intermediate *"your email
  domain matches an organization but you don't have an account yet"* screen
  instead of being redirected.
- **Unmanaged attributes are hidden by default.** `entra_id` reaches the token
  either way, but stays invisible in the admin console until the realm's user
  profile sets `unmanagedAttributePolicy: ENABLED`.
- **lldap attribute names reject underscores** (`a-z A-Z 0-9 -` only), hence
  `entra-id` in LDAP mapped to `entra_id` in Keycloak.
- **`KC_HOSTNAME` is pinned** to `http://localhost:8080` so tokens carry the same
  issuer whether the request came from the browser or from an app container.
- **The lldap `admin` account appears in org-b's realm.** That is a real directory
  service account being federated, and it reinforces step 4: the organisation's
  realm sees everything in the directory, the umbrella sees only who signed in.

---

## Licence

Apache License 2.0 — see [LICENSE](LICENSE).

This is a demonstration project. The credentials, client secrets and signing
material in it are deliberately weak and public; none of it is suitable for any
environment that matters.
