/**
 * App 1 — Option A: one realm per organisation, direct.
 *
 * This app talks to each tenant realm directly. That means it must hold a
 * confidential client and secret FOR EVERY TENANT. Adding tenant number six
 * means editing this file and redeploying.
 *
 * The OIDC flow is hand-rolled rather than pulled from a library so the raw
 * protocol is visible: this is a teaching demo, and the redirects and the
 * back-channel token call are the point.
 */
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Browser redirects and the expected `iss` value. Keycloak is pinned to this
// hostname, so tokens carry it no matter which network path reached the server.
const KC_PUBLIC = process.env.KC_PUBLIC_URL || 'http://localhost:8080';
// Back-channel calls from this container. Different host, same Keycloak.
const KC_INTERNAL = process.env.KC_INTERNAL_URL || 'http://localhost:8080';
const APP_URL = process.env.APP_URL || 'http://localhost:3001';
const PORT = process.env.PORT || 3001;

/**
 * Five tenants, five clients, five secrets. This list is the whole argument
 * against Option A at scale: with 150 organisations it has 150 entries.
 */
const TENANTS = [
  { realm: 'org-a', label: 'Org-A', note: 'Local Keycloak users' },
  { realm: 'org-b', label: 'Org-B', note: 'LDAP federated (lldap)' },
  { realm: 'org-c', label: 'Org-C', note: 'OIDC federated (acme-corp-idp)' },
  { realm: 'org-d', label: 'Org-D', note: 'Local users, own theme + password policy' },
  { realm: 'org-e', label: 'Org-E', note: 'Local Keycloak users' },
].map((t) => ({
  ...t,
  clientId: 'app1-portal',
  clientSecret: `app1-${t.realm}-secret`,
}));

const tenantFor = (realm) => TENANTS.find((t) => t.realm === realm);

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
  .badge { display: inline-block; background: #b91c1c; color: #fff; font-weight: 700;
           font-size: .7rem; letter-spacing: .09em; padding: .25rem .6rem;
           border-radius: 3px; text-transform: uppercase; }
  h1 { font-size: 1.6rem; margin: .8rem 0 .3rem; }
  .sub { opacity: .7; margin: 0 0 1.8rem; }
  .card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
          border-radius: 9px; padding: 1.2rem 1.4rem; margin-bottom: 1.1rem; }
  .warn { border-left: 4px solid #b91c1c;
          background: color-mix(in srgb, #b91c1c 7%, transparent); }
  label { display: block; font-weight: 600; margin-bottom: .45rem; }
  select, button { font: inherit; padding: .6rem .8rem; border-radius: 6px;
                   border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
                   background: Canvas; color: CanvasText; }
  button { background: #b91c1c; color: #fff; border: none; cursor: pointer;
           font-weight: 600; }
  button:hover { background: #991b1b; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: .55rem .6rem; vertical-align: top;
           border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  th { font-weight: 600; opacity: .75; width: 30%; }
  tr:last-child th, tr:last-child td { border-bottom: none; }
  .val { word-break: break-all; font-weight: 600; }
  .note { font-size: .81rem; opacity: .72; margin-top: .35rem; line-height: 1.5;
          font-family: inherit; font-weight: 400; }
  .note code { font-size: .78rem; opacity: .9; }
  details > summary { cursor: pointer; user-select: none; }
  details[open] > summary { margin-bottom: .6rem; }
  h2 { font-size: 1rem; margin: 0 0 .5rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; }
  pre { background: color-mix(in srgb, CanvasText 6%, transparent); padding: .9rem;
        border-radius: 6px; overflow-x: auto; }
  a { color: inherit; }
  .row { display: flex; gap: .7rem; align-items: end; flex-wrap: wrap; }
</style></head><body><main>${body}</main></body></html>`;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: 'app1-demo-session-secret',
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
  const options = TENANTS.map(
    (t) => `<option value="${esc(t.realm)}">${esc(t.label)} — ${esc(t.note)}</option>`,
  ).join('');

  res.send(
    layout(
      'App 1 — Option A',
      `<span class="badge">Option A · realm per tenant</span>
       <h1>App 1 — direct realm login</h1>
       <p class="sub">This app authenticates against each tenant's own realm.</p>

       <div class="card warn">
         <strong>This app holds ${TENANTS.length} client secrets.</strong><br>
         One confidential client is registered in every tenant realm. Onboarding
         tenant ${TENANTS.length + 1} means a new client, a new secret, a config
         change here and a redeploy.
       </div>

       <div class="card">
         <form class="row" method="get" action="/login">
           <div style="flex:1 1 320px">
             <label for="realm">Choose your organisation</label>
             <select id="realm" name="realm" style="width:100%">${options}</select>
           </div>
           <button type="submit">Sign in</button>
         </form>
       </div>

       <div class="card">
         <table>
           <tr><th>Realm</th><th>Client</th><th>Secret held by this app</th></tr>
           ${TENANTS.map(
             (t) =>
               `<tr><td><code>${esc(t.realm)}</code></td><td><code>${esc(t.clientId)}</code></td><td><code>${esc(t.clientSecret)}</code></td></tr>`,
           ).join('')}
         </table>
       </div>`,
    ),
  );
});

app.get('/login', (req, res) => {
  const tenant = tenantFor(req.query.realm);
  if (!tenant) return res.status(400).send(layout('Error', '<h1>Unknown realm</h1>'));

  const verifier = newVerifier();
  const state = b64url(crypto.randomBytes(16));

  req.session.pkce = { verifier, state, realm: tenant.realm };

  const url = new URL(`${KC_PUBLIC}/realms/${tenant.realm}/protocol/openid-connect/auth`);
  url.searchParams.set('client_id', tenant.clientId);
  url.searchParams.set('redirect_uri', `${APP_URL}/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');

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

  const tenant = tenantFor(pkce.realm);

  // Back-channel: the secret and the code verifier never touch the browser.
  const tokenRes = await fetch(
    `${KC_INTERNAL}/realms/${tenant.realm}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${APP_URL}/callback`,
        client_id: tenant.clientId,
        client_secret: tenant.clientSecret,
        code_verifier: pkce.verifier,
      }),
    },
  );

  const tokens = await tokenRes.json();
  console.log(`  back-channel token exchange -> ${tokenRes.status}`);
  if (!tokenRes.ok) {
    return res
      .status(502)
      .send(layout('Token error', `<h1>Token exchange failed</h1><pre>${esc(JSON.stringify(tokens, null, 2))}</pre><p><a href="/">Back</a></p>`));
  }

  req.session.user = {
    realm: tenant.realm,
    // Kept solely as the id_token_hint for RP-initiated logout below.
    idToken: tokens.id_token,
    claims: decodeJwt(tokens.id_token),
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

  const c = user.claims || {};
  const tenant = tenantFor(user.realm);
  const groups = Array.isArray(c.groups) ? c.groups.join(', ') : c.groups;

  res.send(
    layout(
      'App 1 — signed in',
      `<span class="badge">Option A · realm per organisation</span>
       <h1>Signed in directly against <code>${esc(user.realm)}</code></h1>
       <p class="sub">${esc(tenant?.note || '')}</p>

       <div class="card warn">
         <strong>This login used 1 of the ${TENANTS.length} client secrets this app holds.</strong><br>
         Client <code>${esc(tenant?.clientId)}</code> · secret <code>${esc(tenant?.clientSecret)}</code>,
         registered inside realm <code>${esc(user.realm)}</code>. Every organisation needs its own pair.
       </div>

       <div class="card">
         <h2>Where this token came from</h2>
         <table>
           ${row('iss', c.iss,
             'The organisation’s own realm issued this token. App 1 contacted it directly — there is no hub in this path.')}
           ${row('aud', Array.isArray(c.aud) ? c.aud.join(', ') : c.aud)}
           ${row('organization', c.organization,
             'Absent by design. Organizations live in the umbrella hub, which this path never touches — App 1 already knows which realm it asked.')}
         </table>
       </div>

       <div class="card">
         <h2>Who you are</h2>
         <table>
           ${row('preferred_username', c.preferred_username,
             'The raw username from this organisation’s own directory — no namespacing, because there is no hub here for names to collide in.')}
           ${row('name', c.name)}
           ${row('email', c.email)}
           ${row('sub', c.sub, 'This organisation’s identifier for you. The umbrella would assign a different one.')}
         </table>
       </div>

       <div class="card">
         <h2>From the organisation’s directory</h2>
         <table>
           ${row('groups', groups, 'Group membership, mapped straight out of this realm.')}
           ${row('entra_id', c.entra_id, c.entra_id
             ? 'A stable directory identifier, one hop away — straight from the organisation’s own store.'
             : 'Not set — this organisation manages users locally and has no external directory to source it from.')}
         </table>
       </div>

       <div class="card">
         <h2>Session</h2>
         <table>
           ${row('issued at', fmtTime(c.iat))}
           ${row('expires', `${fmtTime(c.exp)} (${fmtDuration(c.iat, c.exp)})`)}
         </table>
       </div>

       <details class="card">
         <summary><strong>Raw ID token claims</strong></summary>
         <p class="note" style="margin:.6rem 0">Kept server-side. The browser holds only a session cookie.</p>
         <pre>${esc(JSON.stringify(c, null, 2))}</pre>
       </details>

       <form method="post" action="/logout"><button type="submit">Sign out</button></form>
       <p class="note" style="margin-top:.8rem">
         Now try the same person through <a href="http://localhost:3002">App 2</a> — same identity, one secret, no dropdown.
       </p>`,
    ),
  );
});

/**
 * RP-initiated logout (OIDC spec).
 *
 * Destroying only this app's session would leave the organisation realm's SSO
 * session alive, so the next sign-in would skip the password prompt entirely.
 * Worse for the demo: that lingering session is also what makes App 2 appear to
 * log you in without asking, since the umbrella brokers into a realm where you
 * are already authenticated.
 */
app.post('/logout', (req, res) => {
  const realm = req.session.user?.realm;
  const idToken = req.session.user?.idToken;

  req.session.destroy(() => {
    if (!realm) return res.redirect('/');
    const url = new URL(`${KC_PUBLIC}/realms/${realm}/protocol/openid-connect/logout`);
    if (idToken) url.searchParams.set('id_token_hint', idToken);
    url.searchParams.set('post_logout_redirect_uri', `${APP_URL}/`);
    res.redirect(url.toString());
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`App 1 (Option A) listening on ${APP_URL}`);
  console.log(`  Keycloak public   : ${KC_PUBLIC}`);
  console.log(`  Keycloak internal : ${KC_INTERNAL}`);
  console.log(`  Holding ${TENANTS.length} client secrets`);
});
