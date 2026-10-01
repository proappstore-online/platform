// A service-binding target that reports what reached it: which worker, the
// method, the path and the headers. Bound under several names (the host's API /
// ADMIN / AGENTS / MCP / KB, agent-teams' PAS_BACKEND / KB), it lets a test prove
// the dispatch went to the right binding with the right request — the wiring
// class of bug the unit suite cannot see.
// Public-action fixtures for the host's page-meta and sitemap tests (#210): the
// only paths that answer with action rows instead of an echo.
function fixtureAction(name, params) {
  if (name === 'fixture_product_meta') {
    return params.id === 'missing'
      ? Response.json({ rows: [] })
      : Response.json({ rows: [{ title: `Product ${params.id}`, description: 'A fine product', image_url: 'https://cdn.test/p.png' }] });
  }
  if (name === 'fixture_sitemap') {
    const pages = { '': [{ path: '/p/a', updated_at: Date.UTC(2026, 8, 1) }, { path: '/p/b', updated_at: '2026-09-02T00:00:00Z' }], '/p/b': [{ path: '/p/c&d' }] };
    return Response.json({ rows: pages[params.cursor] ?? [] });
  }
  return Response.json({ error: 'fixture failure' }, { status: 500 });
}

// Role fixtures for the host's operator gate (#229): the session token names
// what GET /v1/apps/:id/roles/me answers.
function fixtureRoles(authorization) {
  const token = (authorization ?? '').replace(/^Bearer /, '');
  if (token === 'operator-token') return Response.json({ roles: ['member', 'operator'] });
  if (token === 'member-token') return Response.json({ roles: ['member'] });
  if (token === 'expired-token') return Response.json({ error: 'invalid session' }, { status: 401 });
  return Response.json({ error: 'fixture failure' }, { status: 500 });
}

// Visibility fixtures for the host's private-app gate (#259): the session token
// names what GET /v1/apps/:id/visibility/me answers.
//
// The platform sign-in and invite pages (#259 review): `cred-token` is a
// non-GitHub (email + password) account the app was shared with; `invitee-token`
// is refused until it redeems invite JOIN42 for that app, then allowed. State
// lives in this isolate for the run, keyed by app.
const redeemed = new Set();
function fixtureVisibility(authorization, appId) {
  const token = (authorization ?? '').replace(/^Bearer /, '');
  if (token === 'owner-token' || token === 'viewer-token' || token === 'cred-token') return Response.json({ mode: 'private', allowed: true });
  if (token === 'invitee-token') return Response.json({ mode: 'private', allowed: redeemed.has(appId) });
  if (token === 'roleless-token') return Response.json({ mode: 'private', allowed: false });
  if (token === 'member-token') return Response.json({ mode: 'private', allowed: false });
  if (token === 'expired-token') return Response.json({ error: 'invalid session' }, { status: 401 });
  return Response.json({ error: 'fixture failure' }, { status: 500 });
}

// Sign-in fixtures for the platform sign-in page: password logins and /auth/me
// for the visibility tokens; anything else falls through to the echo.
const ACCOUNTS = { casey: 'cred-token', invitee: 'invitee-token', rolelessuser: 'roleless-token' };
const ME = { 'cred-token': { id: 'cred:casey', login: 'casey' }, 'invitee-token': { id: 'cred:inv', login: 'invitee' }, 'roleless-token': { id: 'cred:rl', login: 'rolelessuser' }, 'member-token': { id: 'gh:3', login: 'member' } };
function fixtureAuth(path, authorization, body) {
  const token = (authorization ?? '').replace(/^Bearer /, '');
  if (path === '/v1/auth/credentials/login') {
    const { login, password } = JSON.parse(body || '{}');
    if (password === 'pw' && ACCOUNTS[login]) return Response.json({ token: ACCOUNTS[login] });
    if (ACCOUNTS[login]) return Response.json({ error: 'invalid credentials' }, { status: 401 });
    return null;
  }
  if (path === '/v1/auth/me' && ME[token]) return Response.json(ME[token]);
  const redeem = /^\/v1\/invites\/([A-Z0-9]+)\/redeem$/.exec(path);
  if (redeem && (token === 'invitee-token' || token === 'roleless-token')) {
    const { appId } = JSON.parse(body || '{}');
    if (redeem[1] !== 'JOIN42' || !appId) return Response.json({ error: 'invite not found' }, { status: 404 });
    if (token === 'invitee-token') redeemed.add(appId);
    return Response.json({ ok: true, role: 'viewer', appId });
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {};
    for (const [k, v] of request.headers) headers[k] = v;
    const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
    const fixture = /\/actions\/(fixture_[a-z_]+)$/.exec(url.pathname);
    if (fixture) return fixtureAction(fixture[1], JSON.parse(body || '{}').params ?? {});
    if (env.STUB_NAME === 'api-echo' && /^\/v1\/apps\/gate-[a-z0-9-]+\/roles\/me$/.test(url.pathname)) return fixtureRoles(headers.authorization);
    const vis = env.STUB_NAME === 'api-echo' && /^\/v1\/apps\/(vis-[a-z0-9-]+)\/visibility\/me$/.exec(url.pathname);
    if (vis) return fixtureVisibility(headers.authorization, vis[1]);
    if (env.STUB_NAME === 'api-echo') {
      const auth = fixtureAuth(url.pathname, headers.authorization, body);
      if (auth) return auth;
    }
    return Response.json(
      { worker: env.STUB_NAME, method: request.method, host: url.host, path: url.pathname + url.search, headers, body },
      { headers: { 'X-Stub-Worker': env.STUB_NAME } },
    );
  },
};
