/**
 * App 2 — Option B: umbrella hub + spoke realms.
 *
 * This app holds ONE confidential client, on the umbrella realm, and contains
 * no list of organisations anywhere. Two login paths are offered:
 *
 *   GET /login            no hint at all. Keycloak shows its identity-first
 *                         screen, matches the typed email's domain to an
 *                         Organization, and routes to that organisation's IdP.
 *
 *   GET /login?org=org-b  sends kc_idp_hint, simulating the case where a tenant
 *                         subdomain identified the organisation before redirect.
 *
 * Onboarding organisation number six requires no change to this file.
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
// Config — note there is no organisation list here. That is the point.
// ---------------------------------------------------------------------------

const KC_PUBLIC = process.env.KC_PUBLIC_URL || 'http://localhost:8080';
const KC_INTERNAL = process.env.KC_INTERNAL_URL || 'http://localhost:8080';
const APP_URL = process.env.APP_URL || 'http://localhost:3002';
const PORT = process.env.PORT || 3002;

const REALM = process.env.KC_REALM || 'umbrella';
const CLIENT_ID = process.env.KC_CLIENT_ID || 'app2-portal';
const CLIENT_SECRET = process.env.KC_CLIENT_SECRET || 'app2-umbrella-secret';

// Only used to render the kc_idp_hint shortcuts on the home page. The login
// flow itself never consults this list.
const HINT_SHORTCUTS = ['org-a', 'org-b', 'org-c', 'org-d', 'org-e'];

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

/** Keycloak emits the organization claim either as an array of aliases or as an
 *  object keyed by alias. Normalise to a display string. */
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
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(HERE, 'public')));
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
  if (req.path !== '/healthz' && req.path !== '/style.css') {
    const q = Object.keys(req.query).length ? ` ${JSON.stringify(req.query)}` : '';
    console.log(`${req.method} ${req.path}${q}`);
  }
  next();
});

app.get('/', (_req, res) => {
  const hints = HINT_SHORTCUTS
    .map((o) => `<a href="/login?org=${esc(o)}"><span>kc_idp_hint=${esc(o)}</span></a>`)
    .join('');

  res.send(page('home', 'App 2 — Option B', {
    hints,
    realm: esc(REALM),
    clientId: esc(CLIENT_ID),
  }));
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
    return res.status(400).send(page('message', 'Login failed', {
      heading: 'Login failed', detail: esc(errorDescription || error),
    }));
  }
  if (!pkce || state !== pkce.state) {
    return res.status(400).send(page('message', 'Error', {
      heading: 'Bad state', detail: 'The login response did not match this session.',
    }));
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
    return res.status(502).send(page('message', 'Token error', {
      heading: 'Token exchange failed', detail: esc(JSON.stringify(tokens, null, 2)),
    }));
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

app.get('/profile', (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/');

  // The organization claim rides on the access token when the scope is requested.
  const c = { ...(user.accessClaims || {}), ...(user.idClaims || {}) };
  const org = orgOf(user.idClaims) || orgOf(user.accessClaims);
  const { idp, source } = splitShadowName(c.preferred_username);
  const groups = Array.isArray(c.groups) ? c.groups.join(', ') : c.groups;
  const emailDomain = (c.email || '').split('@')[1];

  res.send(page('profile', 'App 2 — signed in', {
    orgHeading: org ? ` — routed to <code>${esc(org)}</code>` : '',

    routingRows:
      row('organization', org, emailDomain
        ? `Keycloak matched your email domain <code>${esc(emailDomain)}</code> to this Organization, then redirected to the identity provider linked to it.`
        : 'Assigned automatically on first login by the IdP&harr;Organization link.') +
      row('identity provider', idp || '—',
        'The organisation realm you actually authenticated against. Your password was never seen by the umbrella.') +
      row('iss', c.iss,
        'App 2 only ever talks to this one realm, whichever organisation you belong to.'),

    identityRows:
      row('preferred_username', c.preferred_username, idp
        ? `Namespaced by the Username Template Importer. Your own directory knows you as <code>${esc(source)}</code> — so <code>${esc(source)}</code> in a different organisation would not collide with you here.`
        : 'No namespacing applied.') +
      row('name', c.name) +
      row('email', c.email,
        'Per-organisation domains keep emails unique across tenants, and drive the routing above.') +
      row('email_verified', String(c.email_verified ?? '—')),

    directoryRows:
      row('groups', groups,
        'Group membership from the source directory, re-applied on <em>every</em> login (sync mode FORCE) rather than only the first — so changes at the source are never stale here.') +
      row('entra_id', c.entra_id, c.entra_id
        ? 'A stable directory identifier that travelled intact from the organisation’s own store, through its realm, through the umbrella, to this page. This is the join key that ties an application record back to a directory entry.'
        : 'Not set — this organisation manages users locally and has no external directory to source it from.'),

    sessionRows:
      row('sub', c.sub,
        'The umbrella’s stable identifier for you. Different from your identifier in the organisation realm.') +
      row('sid', c.sid) +
      row('aud', Array.isArray(c.aud) ? c.aud.join(', ') : c.aud) +
      row('scope', c.scope) +
      row('issued at', fmtTime(c.iat)) +
      row('expires', `${fmtTime(c.exp)} (${fmtDuration(c.iat, c.exp)})`),

    idToken: esc(JSON.stringify(user.idClaims, null, 2)),
    accessToken: esc(JSON.stringify(user.accessClaims, null, 2)),
  }));
});

/**
 * RP-initiated logout (OIDC spec).
 *
 * Destroying only this app's session would leave the Keycloak SSO session alive
 * at BOTH levels — the umbrella and the organisation realm behind it — so the
 * next /login would find a live session and issue a code without ever prompting.
 * That looks like "it skipped the login page", and it is the single most
 * confusing thing to hit while demoing.
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
  console.log('  Organisations hardcoded: 0');
});
