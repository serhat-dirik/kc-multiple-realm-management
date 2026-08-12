/**
 * App 2 — Option B: umbrella hub + spoke realms.
 *
 * This app holds ONE confidential client, on the umbrella realm, and contains
 * no list of tenants anywhere. Two login paths are offered:
 *
 *   GET /login            no hint at all. Keycloak shows its identity-first
 *                         screen, matches the typed email's domain to an
 *                         Organization, and routes to that org's IdP.
 *
 *   GET /login?org=org-b  sends kc_idp_hint, simulating the flow where
 *                         a tenant subdomain identifies the organisation before redirect.
 *
 * Onboarding tenant number six requires no change to this file.
 */
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';

// ---------------------------------------------------------------------------
// Config — note there is no tenant list here. That is the point.
// ---------------------------------------------------------------------------

const KC_PUBLIC = process.env.KC_PUBLIC_URL || 'http://localhost:8080';
const KC_INTERNAL = process.env.KC_INTERNAL_URL || 'http://localhost:8080';
const APP_URL = process.env.APP_URL || 'http://localhost:3002';
const PORT = process.env.PORT || 3002;

const REALM = process.env.KC_REALM || 'umbrella';
const CLIENT_ID = process.env.KC_CLIENT_ID || 'app2-portal';
const CLIENT_SECRET = process.env.KC_CLIENT_SECRET || 'app2-umbrella-secret';

// ---------------------------------------------------------------------------
// OIDC helpers
// ---------------------------------------------------------------------------

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const newVerifier = () => b64url(crypto.randomBytes(32));
const challengeFor = (verifier) =>
  b64url(crypto.createHash('sha256').update(verifier).digest());

const decodeJwt = (token) => {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

/**
 * Keycloak emits the organization claim either as an array of aliases or as an
 * object keyed by alias. Normalise to a display string.
 */
const orgOf = (claims) => {
  const o = claims?.organization;
  if (!o) return null;
  if (Array.isArray(o)) return o.join(', ');
  if (typeof o === 'object') return Object.keys(o).join(', ');
  return String(o);
};

/**
 * Shadow usernames are namespaced by the Username Template Importer as
 * `<idp-alias>.<source username>`. Split them back apart so the page can show
 * both halves — the umbrella's name for this person, and the name their own
 * directory knows them by.
 *
 * org-c chains twice (`org-c.acme.user-1`) because it brokers onward to a
 * corporate IdP, so only the FIRST segment is stripped.
 */
const splitShadowName = (username) => {
  if (!username || !username.includes('.')) return { idp: null, source: username };
  const i = username.indexOf('.');
  return { idp: username.slice(0, i), source: username.slice(i + 1) };
};

const fmtTime = (epoch) =>
  epoch ? new Date(epoch * 1000).toISOString().replace('T', ' ').replace(/\..+/, ' UTC') : '—';

const fmtDuration = (from, to) =>
  from && to ? `${Math.round((to - from) / 60)} min` : '—';

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const layout = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif;
         margin: 0; padding: 2.5rem 1.5rem; display: flex; justify-content: center;
         background: Canvas; color: CanvasText; }
  main { width: 100%; max-width: 720px; }
  .badge { display: inline-block; background: #1d4ed8; color: #fff; font-weight: 700;
           font-size: .7rem; letter-spacing: .09em; padding: .25rem .6rem;
           border-radius: 3px; text-transform: uppercase; }
  h1 { font-size: 1.6rem; margin: .8rem 0 .3rem; }
  h2 { font-size: 1rem; margin: 0 0 .5rem; }
  .sub { opacity: .7; margin: 0 0 1.8rem; }
  .card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
          border-radius: 9px; padding: 1.2rem 1.4rem; margin-bottom: 1.1rem; }
  .good { border-left: 4px solid #15803d;
          background: color-mix(in srgb, #15803d 7%, transparent); }
  button { font: inherit; padding: .6rem .9rem; border-radius: 6px; border: none;
           background: #1d4ed8; color: #fff; cursor: pointer; font-weight: 600; }
  button:hover { background: #1e40af; }
  button.ghost { background: transparent; color: CanvasText;
                 border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: .55rem .6rem; vertical-align: top;
           border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  th { font-weight: 600; opacity: .75; width: 30%; }
  tr:last-child th, tr:last-child td { border-bottom: none; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; }
  .val { word-break: break-all; font-weight: 600; }
  .note { font-size: .81rem; opacity: .72; margin-top: .35rem; line-height: 1.5;
          font-family: inherit; font-weight: 400; }
  .note code { font-size: .78rem; opacity: .9; }
  details > summary { cursor: pointer; user-select: none; }
  details[open] > summary { margin-bottom: .6rem; }
  pre { background: color-mix(in srgb, CanvasText 6%, transparent); padding: .9rem;
        border-radius: 6px; overflow-x: auto; }
  .hints { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .7rem; }
  .hints a { text-decoration: none; }
  .hints span { display: inline-block; padding: .4rem .7rem; border-radius: 6px;
                border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
                font-size: .85rem; color: CanvasText; }
</style></head><body><main>${body}</main></body></html>`;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: 'app2-demo-session-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { sameSite: 'lax' },
  }),
);

// Request log. Without this the app is silent and ./scripts/logs.sh shows
// nothing during a login, which is exactly when you want to watch it.
app.use((req, _res, next) => {
  if (req.path !== '/healthz') {
    const q = Object.keys(req.query).length ? ` ${JSON.stringify(req.query)}` : '';
    console.log(`${req.method} ${req.path}${q}`);
  }
  next();
});

app.get('/', (req, res) => {
  const hints = ['org-a', 'org-b', 'org-c', 'org-d', 'org-e']
    .map((o) => `<a href="/login?org=${o}"><span>kc_idp_hint=${o}</span></a>`)
    .join('');

  res.send(
    layout(
      'App 2 — Option B',
      `<span class="badge">Option B · umbrella hub</span>
       <h1>App 2 — umbrella login</h1>
       <p class="sub">This app talks to one realm and knows nothing about tenants.</p>

       <div class="card good">
         <strong>This app holds 1 client secret and contains no tenant list.</strong><br>
         Onboarding tenant six is a Keycloak change only — no config here, no redeploy.
       </div>

       <div class="card">
         <h2>Path 1 — identity-first (no hint)</h2>
         <p class="sub" style="margin:0 0 .9rem">
           Keycloak asks for an email, matches its domain to an Organization and
           routes to that tenant's realm. Try <code>j.smith@orgb.example</code>.
         </p>
         <form method="get" action="/login"><button type="submit">Sign in</button></form>
       </div>

       <div class="card">
         <h2>Path 2 — kc_idp_hint (tenant already resolved)</h2>
         <p class="sub" style="margin:0 0 .3rem">
           Simulates the case where: the tenant subdomain identified the organisation, so
           the IdP selection screen is skipped entirely.
         </p>
         <div class="hints">${hints}</div>
       </div>

       <div class="card">
         <table>
           <tr><th>Realm</th><td><code>${esc(REALM)}</code></td></tr>
           <tr><th>Client</th><td><code>${esc(CLIENT_ID)}</code></td></tr>
           <tr><th>Secrets held</th><td><code>1</code></td></tr>
           <tr><th>Tenants hardcoded</th><td><code>0</code></td></tr>
         </table>
       </div>`,
    ),
  );
});

app.get('/login', (req, res) => {
  const verifier = newVerifier();
  const state = b64url(crypto.randomBytes(16));
  req.session.pkce = { verifier, state };

  const url = new URL(`${KC_PUBLIC}/realms/${REALM}/protocol/openid-connect/auth`);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', `${APP_URL}/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email organization');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');

  // Optional. Without it Keycloak runs identity-first and routes by email domain.
  if (req.query.org) url.searchParams.set('kc_idp_hint', String(req.query.org));

  res.redirect(url.toString());
});

app.get('/callback', async (req, res) => {
  const pkce = req.session.pkce;
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res
      .status(400)
      .send(layout('Login failed', `<h1>Login failed</h1><pre>${esc(errorDescription || error)}</pre><p><a href="/">Back</a></p>`));
  }
  if (!pkce || state !== pkce.state) {
    return res.status(400).send(layout('Error', '<h1>Bad state</h1><p><a href="/">Back</a></p>'));
  }

  const tokenRes = await fetch(`${KC_INTERNAL}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${APP_URL}/callback`,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code_verifier: pkce.verifier,
    }),
  });

  const tokens = await tokenRes.json();
  console.log(`  back-channel token exchange -> ${tokenRes.status}`);
  if (!tokenRes.ok) {
    return res
      .status(502)
      .send(layout('Token error', `<h1>Token exchange failed</h1><pre>${esc(JSON.stringify(tokens, null, 2))}</pre><p><a href="/">Back</a></p>`));
  }

  req.session.user = {
    // The raw ID token is kept solely as the id_token_hint for RP-initiated
    // logout. Without it, signing out cannot end the Keycloak session and the
    // next login silently reuses the old one.
    idToken: tokens.id_token,
    idClaims: decodeJwt(tokens.id_token),
    accessClaims: decodeJwt(tokens.access_token),
  };
  delete req.session.pkce;
  res.redirect('/profile');
});

/** One row of the claims tables: name, value, and why it is worth looking at. */
const row = (claim, value, note) => `
  <tr>
    <th><code>${esc(claim)}</code></th>
    <td><code class="val">${esc(value === undefined || value === null || value === '' ? '—' : value)}</code>
      ${note ? `<div class="note">${note}</div>` : ''}</td>
  </tr>`;

app.get('/profile', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/');

  // The organization claim rides on the access token when the scope is requested.
  const c = { ...(user.accessClaims || {}), ...(user.idClaims || {}) };
  const org = orgOf(user.idClaims) || orgOf(user.accessClaims);
  const { idp, source } = splitShadowName(c.preferred_username);
  const groups = Array.isArray(c.groups) ? c.groups.join(', ') : c.groups;
  const emailDomain = (c.email || '').split('@')[1];

  res.send(
    layout(
      'App 2 — signed in',
      `<span class="badge">Option B · umbrella hub</span>
       <h1>Signed in${org ? ` — routed to <code>${esc(org)}</code>` : ''}</h1>
       <p class="sub">App 2 sent no tenant hint. Keycloak decided where this login belonged.</p>

       <div class="card good">
         <strong>App 2 holds 1 client secret and knows about 0 tenants.</strong><br>
         Every claim below arrived through a single client on a single realm.
       </div>

       <div class="card">
         <h2>How you got here</h2>
         <table>
           ${row('organization', org, emailDomain
             ? `Keycloak matched your email domain <code>${esc(emailDomain)}</code> to this Organization, then redirected to the identity provider linked to it.`
             : 'Assigned automatically on first login by the IdP&harr;Organization link.')}
           ${row('identity provider', idp || '—',
             'The organisation realm you actually authenticated against. Your password was never seen by the umbrella.')}
           ${row('iss', c.iss,
             'App 2 only ever talks to this one realm, whichever organisation you belong to.')}
         </table>
       </div>

       <div class="card">
         <h2>Who you are</h2>
         <table>
           ${row('preferred_username', c.preferred_username,
             idp ? `Namespaced by the Username Template Importer. Your own directory knows you as <code>${esc(source)}</code> — so <code>${esc(source)}</code> in a different organisation would not collide with you here.`
                 : 'No namespacing applied.')}
           ${row('name', c.name)}
           ${row('email', c.email, 'Per-organisation domains keep emails unique across tenants, and drive the routing above.')}
           ${row('email_verified', String(c.email_verified ?? '—'))}
         </table>
       </div>

       <div class="card">
         <h2>Carried from your organisation's own directory</h2>
         <table>
           ${row('groups', groups,
             'Group membership from the source directory, re-applied on <em>every</em> login (sync mode FORCE) rather than only the first — so changes at the source are never stale here.')}
           ${row('entra_id', c.entra_id, c.entra_id
             ? 'A stable directory identifier that travelled intact from the organisation’s own store, through its realm, through the umbrella, to this page. This is the join key that ties an application record back to a directory entry.'
             : 'Not set — this organisation manages users locally and has no external directory to source it from.')}
         </table>
       </div>

       <div class="card">
         <h2>Session</h2>
         <table>
           ${row('sub', c.sub, 'The umbrella’s stable identifier for you. Different from your identifier in the organisation realm.')}
           ${row('sid', c.sid)}
           ${row('aud', Array.isArray(c.aud) ? c.aud.join(', ') : c.aud)}
           ${row('scope', c.scope)}
           ${row('issued at', fmtTime(c.iat))}
           ${row('expires', `${fmtTime(c.exp)} (${fmtDuration(c.iat, c.exp)})`)}
         </table>
       </div>

       <details class="card">
         <summary><strong>Raw tokens</strong></summary>
         <p class="note" style="margin:.6rem 0">These stay server-side. The browser holds only a session cookie.</p>
         <strong>ID token</strong>
         <pre>${esc(JSON.stringify(user.idClaims, null, 2))}</pre>
         <strong>Access token</strong>
         <pre>${esc(JSON.stringify(user.accessClaims, null, 2))}</pre>
       </details>

       <form method="post" action="/logout"><button type="submit">Sign out</button></form>
       <p class="note" style="margin-top:.8rem">
         Try the same person through <a href="http://localhost:3001">App 1</a> to see the Option A path.
       </p>`,
    ),
  );
});

/**
 * RP-initiated logout (OIDC spec).
 *
 * Destroying only this app's session would leave the Keycloak SSO session alive
 * at BOTH levels — the umbrella and the organisation realm behind it — so the
 * next /login would find a live session and issue a code without ever prompting.
 * That looks like "it skipped the login page", and it is the single most
 * confusing thing to hit while demoing.
 *
 * Redirecting to end_session_endpoint with the id_token_hint ends the umbrella
 * session, and Keycloak propagates the logout on to the brokered identity
 * provider, so the organisation realm's session goes too.
 */
app.post('/logout', (req, res) => {
  const idToken = req.session.user?.idToken;

  req.session.destroy(() => {
    const url = new URL(`${KC_PUBLIC}/realms/${REALM}/protocol/openid-connect/logout`);
    if (idToken) url.searchParams.set('id_token_hint', idToken);
    url.searchParams.set('post_logout_redirect_uri', `${APP_URL}/`);
    res.redirect(url.toString());
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`App 2 (Option B) listening on ${APP_URL}`);
  console.log(`  Realm  : ${REALM}`);
  console.log(`  Client : ${CLIENT_ID}`);
  console.log(`  Tenants hardcoded: 0`);
});
