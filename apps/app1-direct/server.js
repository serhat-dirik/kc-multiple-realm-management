/**
 * App 1 — Option A: one realm per organisation, direct.
 *
 * This app talks to each organisation's realm directly. That means it must hold
 * a confidential client and secret FOR EVERY ORGANISATION. Adding organisation
 * number six means editing this file and redeploying.
 *
 * Markup lives in views/, styling in public/style.css. Everything below is the
 * OIDC flow, hand-rolled rather than pulled from a library so the redirects and
 * the back-channel token call stay visible.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
 * Five organisations, five clients, five secrets. This list is the whole
 * argument against Option A at scale: with 150 organisations it has 150 entries.
 */
const TENANTS = [
  { realm: 'org-a', label: 'Org-A', note: 'Local Keycloak users' },
  { realm: 'org-b', label: 'Org-B', note: 'LDAP federated (lldap)' },
  { realm: 'org-c', label: 'Org-C', note: 'OIDC federated (acme-corp-idp)' },
  { realm: 'org-d', label: 'Org-D', note: 'Local users, own password policy' },
  { realm: 'org-e', label: 'Org-E', note: 'Local Keycloak users' },
].map((t) => ({
  ...t,
  clientId: 'app1-portal',
  clientSecret: `app1-${t.realm}-secret`,
}));

const tenantFor = (realm) => TENANTS.find((t) => t.realm === realm);

// ---------------------------------------------------------------------------
// Templating
//
// Views are plain HTML with {{placeholder}} slots. Anything that needs a loop
// or a condition is built here as a fragment and injected, which keeps the
// markup readable and the logic in one place. No template engine needed.
// ---------------------------------------------------------------------------

const readView = (name) => fs.readFileSync(path.join(HERE, 'views', `${name}.html`), 'utf8');

const VIEWS = {
  layout: readView('layout'),
  home: readView('home'),
  profile: readView('profile'),
  message: readView('message'),
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Replace every {{key}} in a template. Values are inserted verbatim, so
 *  callers escape anything that came from a token. */
const fill = (template, values) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in values ? values[key] : ''));

const page = (view, title, values) =>
  fill(VIEWS.layout, { title: esc(title), body: fill(VIEWS[view], values) });

/** One row of a claims table: name, value, and why it is worth looking at. */
const row = (claim, value, note) => `
  <tr>
    <th><code>${esc(claim)}</code></th>
    <td><code class="val">${esc(value === undefined || value === null || value === '' ? '—' : value)}</code>
      ${note ? `<div class="note">${note}</div>` : ''}</td>
  </tr>`;

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
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(HERE, 'public')));
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
  if (req.path !== '/healthz' && req.path !== '/style.css') {
    const q = Object.keys(req.query).length ? ` ${JSON.stringify(req.query)}` : '';
    console.log(`${req.method} ${req.path}${q}`);
  }
  next();
});

app.get('/', (_req, res) => {
  res.send(page('home', 'App 1 — Option A', {
    tenantCount: TENANTS.length,
    nextTenant: TENANTS.length + 1,
    options: TENANTS.map(
      (t) => `<option value="${esc(t.realm)}">${esc(t.label)} — ${esc(t.note)}</option>`,
    ).join(''),
    secretRows: TENANTS.map(
      (t) => `<tr><td><code>${esc(t.realm)}</code></td><td><code>${esc(t.clientId)}</code></td>` +
             `<td><code>${esc(t.clientSecret)}</code></td></tr>`,
    ).join(''),
  }));
});

app.get('/login', (req, res) => {
  const tenant = tenantFor(req.query.realm);
  if (!tenant) {
    return res.status(400).send(page('message', 'Error', {
      heading: 'Unknown realm', detail: esc(String(req.query.realm)),
    }));
  }

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
    return res.status(400).send(page('message', 'Login failed', {
      heading: 'Login failed', detail: esc(errorDescription || error),
    }));
  }
  if (!pkce || state !== pkce.state) {
    return res.status(400).send(page('message', 'Error', {
      heading: 'Bad state', detail: 'The login response did not match this session.',
    }));
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
    return res.status(502).send(page('message', 'Token error', {
      heading: 'Token exchange failed', detail: esc(JSON.stringify(tokens, null, 2)),
    }));
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

app.get('/profile', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/');

  const c = user.claims || {};
  const tenant = tenantFor(user.realm);
  const groups = Array.isArray(c.groups) ? c.groups.join(', ') : c.groups;

  res.send(page('profile', 'App 1 — signed in', {
    realm: esc(user.realm),
    note: esc(tenant?.note || ''),
    tenantCount: TENANTS.length,
    clientId: esc(tenant?.clientId),
    clientSecret: esc(tenant?.clientSecret),

    originRows:
      row('iss', c.iss,
        'The organisation’s own realm issued this token. App 1 contacted it directly — there is no hub in this path.') +
      row('aud', Array.isArray(c.aud) ? c.aud.join(', ') : c.aud) +
      row('organization', c.organization,
        'Absent by design. Organizations live in the umbrella hub, which this path never touches — App 1 already knows which realm it asked.'),

    identityRows:
      row('preferred_username', c.preferred_username,
        'The raw username from this organisation’s own directory — no namespacing, because there is no hub here for names to collide in.') +
      row('name', c.name) +
      row('email', c.email) +
      row('sub', c.sub,
        'This organisation’s identifier for you. The umbrella would assign a different one.'),

    directoryRows:
      row('groups', groups, 'Group membership, mapped straight out of this realm.') +
      row('entra_id', c.entra_id, c.entra_id
        ? 'A stable directory identifier, one hop away — straight from the organisation’s own store.'
        : 'Not set — this organisation manages users locally and has no external directory to source it from.'),

    sessionRows:
      row('issued at', fmtTime(c.iat)) +
      row('expires', `${fmtTime(c.exp)} (${fmtDuration(c.iat, c.exp)})`),

    idToken: esc(JSON.stringify(c, null, 2)),
  }));
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
