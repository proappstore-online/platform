/**
 * PAS Agent Teams Worker — entry point.
 * Routes HTTP to the per-project Durable Object.
 * Security: auth middleware + ownership check on every DO request.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import type { Project, Ticket } from './types.ts';
import { verifyToken, extractToken } from './auth.ts';
import { MAX_PROJECTS_PER_USER } from './rate-limit.ts';
export { ProjectDO } from './project-do.ts';

export type Bindings = {
  PROJECT: DurableObjectNamespace;
  AGENT_STORAGE: R2Bucket;
  /** Shared PAS D1 — the agent_projects index (list a user's projects). */
  DB: D1Database;
  PAS_BACKEND: Fetcher;
  /** Service binding to the PAS admin Worker — for the agent deploy flow
   *  (repo create + file push + registry). */
  ADMIN?: Fetcher;
  FAS_API_BASE: string;
  PAS_API_BASE: string;
  /**
   * Shared secret for authenticating internal calls to the PAS backend
   * (e.g. GET /v1/keys/resolve/:provider). Mirrors INTERNAL_TOKEN on the
   * backend Worker. Set via `wrangler secret put INTERNAL_TOKEN`.
   */
  INTERNAL_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS — strict: only exact proappstore subdomains and proappstore-* Pages previews
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return null;
    try {
      const host = new URL(origin).hostname;
      if (host === 'localhost' || host === '127.0.0.1') return origin;
      if (host.endsWith('.proappstore.online') || host === 'proappstore.online') return origin;
      // Only allow Pages preview domains that start with proappstore-
      if (host.endsWith('.pages.dev') && host.startsWith('proappstore-')) return origin;
      return null;
    } catch { return null; }
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'X-Internal-Token'],
  maxAge: 600,
}));

// Auth middleware — all /v1/* routes require a valid FAS session OR internal token.
// Internal token (X-Internal-Token) is for service-to-service calls (MCP server,
// admin). It resolves the project owner from the D1 index so the DO sees a valid
// user context. Read-only — no userToken is set, so autonomous agent dispatch
// (which needs the owner's session) won't fire from an internal-token call.
app.use('/v1/*', async (c, next) => {
  // Internal token bypass — for MCP server and admin service calls
  const internalToken = c.req.header('X-Internal-Token');
  if (internalToken && c.env.INTERNAL_TOKEN && internalToken === c.env.INTERNAL_TOKEN) {
    // Resolve the project owner from the slug in the URL so the DO sees
    // a valid X-User-Id. Falls back to a synthetic admin id for non-project routes.
    const slugMatch = c.req.path.match(/^\/v1\/projects\/([a-z][a-z0-9-]+)/);
    let userId = 'internal:admin';
    if (slugMatch) {
      try {
        const row = await c.env.DB.prepare('SELECT owner_id FROM agent_projects WHERE slug = ?')
          .bind(slugMatch[1]).first<{ owner_id: string }>();
        if (row) userId = row.owner_id;
      } catch { /* fall through to synthetic admin */ }
    }
    c.set('user' as never, { id: userId, login: 'internal' });
    await next();
    return;
  }

  const token = extractToken(c.req.raw);
  if (!token) return c.json({ error: 'missing bearer token' }, 401);

  const user = await verifyToken(c.env.FAS_API_BASE, token);
  if (!user) return c.json({ error: 'invalid or expired session' }, 401);

  c.set('user' as never, user);
  c.set('userToken' as never, token);
  await next();
});

// Health
app.get('/health', (c) => c.json({ ok: true, version: '0.3.2', stage: 'byo-debug' }));

// ── KB sharing (public, no auth) ──────────────────────────────
// Serves KB content to anyone with a valid share link.
// The share link ID is the access token — no user session needed.

app.get('/kb/:slug/s/:shareId', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request(`https://do/kb/share/${c.req.param('shareId')}`, {
    headers: { 'Content-Type': 'application/json' },
  }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get('/kb/:slug/s/:shareId/:path{.+}', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const filePath = c.req.param('path');
  const res = await stub.fetch(new Request(`https://do/kb/share/${c.req.param('shareId')}/file?path=${encodeURIComponent(filePath)}`, {
    headers: { 'Content-Type': 'application/json' },
  }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Helper: forward to DO with user ID header ───────────────

function forwardToDO(
  stub: DurableObjectStub,
  path: string,
  userId: string,
  opts?: { method?: string; body?: string; raw?: Request; userToken?: string | undefined },
): Promise<Response> {
  if (opts?.raw) {
    // For WebSocket upgrades, clone the request with the user ID header
    const headers = new Headers(opts.raw.headers);
    headers.set('X-User-Id', userId);
    return stub.fetch(new Request(opts.raw.url, { headers, method: opts.raw.method }));
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Id': userId,
  };
  // Forward the owner session token so the DO can authenticate autonomous
  // agent tool dispatch (captured at play time).
  if (opts?.userToken) headers['X-User-Token'] = opts.userToken;
  return stub.fetch(new Request(`https://do${path}`, {
    method: opts?.method ?? 'GET',
    headers,
    ...(opts?.body ? { body: opts.body } : {}),
  }));
}

/**
 * Resolve the authed user + the project DO stub for a `:slug` route, proxy to
 * `path` on the DO, and relay its response verbatim. Collapses the identical
 * user→stub→forward→Response boilerplate that every project sub-route repeats.
 * `forwardBody` re-sends the request's JSON body to the DO (Hono caches the
 * parsed body, so this is safe even after a route already read it for validation).
 */
async function relay(
  c: Context<{ Bindings: Bindings }>,
  path: string,
  opts?: { method?: string; forwardBody?: boolean },
): Promise<Response> {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')!));
  const init: { method?: string; body?: string } = {};
  if (opts?.method) init.method = opts.method;
  if (opts?.forwardBody) init.body = JSON.stringify(await c.req.json());
  // Preserve the incoming query string (e.g. /chat/history?thread=research) — the
  // DO reads it off request.url. Without this every thread-scoped GET/DELETE
  // silently fell back to the default thread.
  const search = new URL(c.req.url).search;
  const res = await forwardToDO(stub, path + search, user.id, init);
  return new Response(res.body, { status: res.status, headers: res.headers });
}

// ── Project lifecycle ───────────────────────────────────────

// Create a new project
app.post('/v1/projects', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const body = await c.req.json<{ name: string; slug: string; costCapMonthlyUsd?: number; idea?: string }>();

  if (!body.name || !body.slug) return c.json({ error: 'name and slug required' }, 400);
  if (!/^[a-z][a-z0-9-]{1,56}$/.test(body.slug)) return c.json({ error: 'slug must be 2-58 chars, lowercase alphanumeric with hyphens' }, 400);
  if (body.name.length > 100) return c.json({ error: 'name too long (max 100)' }, 400);
  if (body.idea && body.idea.length > 65536) return c.json({ error: 'idea too long (max 64KB)' }, 400);

  // Validate cost cap range
  const cap = body.costCapMonthlyUsd ?? 50.0;
  if (cap < 1 || cap > 1000) return c.json({ error: 'costCapMonthlyUsd must be 1-1000' }, 400);

  // Per-account project quota — prevents runaway repo/infra creation. Re-creating
  // a slug the caller already owns is idempotent and doesn't count. Fail-open on a
  // transient index error so a flaky DB never blocks a legitimate creation.
  try {
    const owned = await c.env.DB.prepare('SELECT 1 FROM agent_projects WHERE slug = ? AND owner_id = ?')
      .bind(body.slug, user.id).first();
    if (!owned) {
      const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM agent_projects WHERE owner_id = ?')
        .bind(user.id).first<{ n: number }>();
      if ((row?.n ?? 0) >= MAX_PROJECTS_PER_USER) {
        return c.json({ error: `Project limit reached (${MAX_PROJECTS_PER_USER} per account). Delete an app to make room.` }, 429);
      }
    }
  } catch { /* fail open */ }

  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(body.slug));
  // The agent team (BA/Dev/QA) is seeded on create. If an initial idea is given,
  // seed the first ticket too — so the project is play-ready in one step: create
  // → press play → agents start building.
  const res = await forwardToDO(stub, '/project', user.id, {
    method: 'PUT',
    body: JSON.stringify({ name: body.name, slug: body.slug, ownerId: user.id, costCapMonthlyUsd: cap, idea: body.idea }),
  });
  // Index the project so the creator console can list a user's projects (the DOs
  // are isolated and can't be enumerated). Best-effort — don't fail create on it.
  if (res.ok) {
    try {
      await c.env.DB.prepare(
        `INSERT INTO agent_projects (slug, owner_id, name, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET name = excluded.name`,
      ).bind(body.slug, user.id, body.name, Date.now()).run();
    } catch { /* index write is non-fatal */ }
  }
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// List the caller's agent-teams projects (for merging into the console app list)
app.get('/v1/projects', async (c) => {
  const user = c.get('user' as never) as { id: string };
  try {
    const rows = await c.env.DB.prepare(
      'SELECT slug, name, created_at FROM agent_projects WHERE owner_id = ? ORDER BY created_at DESC',
    ).bind(user.id).all<{ slug: string; name: string; created_at: number }>();
    return c.json({
      projects: (rows.results ?? []).map((r) => ({ slug: r.slug, name: r.name, createdAt: r.created_at })),
    });
  } catch {
    return c.json({ projects: [] });
  }
});

// Get project
app.get('/v1/projects/:slug', (c) => relay(c, '/project'));

// ── Play/Pause ──────────────────────────────────────────────
// Play forwards the owner session token so the DO can authenticate autonomous
// agent tool dispatch — so it keeps its own forward (relay doesn't pass tokens).
app.post('/v1/projects/:slug/play', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const userToken = c.get('userToken' as never) as string | undefined;
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/project/play', user.id, { method: 'POST', userToken });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/v1/projects/:slug/pause', (c) => relay(c, '/project/pause', { method: 'POST' }));
app.post('/v1/projects/:slug/research', (c) => relay(c, '/project/research', { method: 'POST' }));

// ── Chat (PO agent) ─────────────────────────────────────────

app.post('/v1/projects/:slug/chat', (c) => relay(c, '/chat', { method: 'POST', forwardBody: true }));
app.get('/v1/projects/:slug/chat/history', (c) => relay(c, '/chat/history'));
app.delete('/v1/projects/:slug/chat/history', (c) => relay(c, '/chat/history', { method: 'DELETE' }));

// ── Role configs ────────────────────────────────────────────

app.get('/v1/projects/:slug/roles', (c) => relay(c, '/roles'));
app.put('/v1/projects/:slug/roles', (c) => relay(c, '/roles', { method: 'PUT', forwardBody: true }));
// Resolved catalog of every agent (identity + prompt + skills + model) — read-only.
app.get('/v1/projects/:slug/agents', (c) => relay(c, '/agents'));
// Monthly cost cap for the team (the budget that auto-pauses the loop when hit).
app.put('/v1/projects/:slug/budget', (c) => relay(c, '/budget', { method: 'PUT', forwardBody: true }));

// ── Tickets ─────────────────────────────────────────────────

app.get('/v1/projects/:slug/tickets', (c) => relay(c, '/tickets'));

app.post('/v1/projects/:slug/tickets', async (c) => {
  const body = await c.req.json<{ title: string; rawIdea: string }>();
  // Input validation
  if (!body.title || body.title.length > 200) return c.json({ error: 'title required (max 200 chars)' }, 400);
  if (!body.rawIdea || body.rawIdea.length > 65536) return c.json({ error: 'rawIdea required (max 64KB)' }, 400);
  return relay(c, '/tickets', { method: 'POST', forwardBody: true });
});

app.get('/v1/projects/:slug/tickets/:id', (c) => relay(c, `/tickets/${c.req.param('id')}`));
app.patch('/v1/projects/:slug/tickets/:id', (c) => relay(c, `/tickets/${c.req.param('id')}`, { method: 'PATCH', forwardBody: true }));
app.delete('/v1/projects/:slug/tickets/:id', (c) => relay(c, `/tickets/${c.req.param('id')}`, { method: 'DELETE' }));
app.post('/v1/projects/:slug/tickets/:id/transition', (c) => relay(c, `/tickets/${c.req.param('id')}/transition`, { method: 'POST', forwardBody: true }));

// ── Messages ────────────────────────────────────────────────

app.get('/v1/projects/:slug/tickets/:id/messages', (c) => relay(c, `/tickets/${c.req.param('id')}/messages`));

app.post('/v1/projects/:slug/tickets/:id/messages', async (c) => {
  // Body size limit (1MB)
  const contentLength = parseInt(c.req.header('Content-Length') ?? '0', 10);
  if (contentLength > 1_048_576) return c.json({ error: 'message body too large (max 1MB)' }, 413);
  return relay(c, `/tickets/${c.req.param('id')}/messages`, { method: 'POST', forwardBody: true });
});

// ── Agent run ───────────────────────────────────────────────

app.post('/v1/projects/:slug/tickets/:id/run', (c) => relay(c, `/tickets/${c.req.param('id')}/run`, { method: 'POST', forwardBody: true }));

// ── Cost ────────────────────────────────────────────────────

app.get('/v1/projects/:slug/cost', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/cost', user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get('/v1/projects/:slug/cost/detail', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/cost/detail', user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/v1/projects/:slug/generate-listing', async (c) => {
  return relay(c, '/generate-listing', { method: 'POST', forwardBody: true });
});

// ── Activity log (persisted audit trail) ────────────────────

app.get('/v1/projects/:slug/activity', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/activity', user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.delete('/v1/projects/:slug/activity', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/activity', user.id, { method: 'DELETE' });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Project memory (durable decisions/facts) ────────────────

app.get('/v1/projects/:slug/memory', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/memory', user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/v1/projects/:slug/memory', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/memory', user.id, { method: 'POST', body: JSON.stringify(await c.req.json()) });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.delete('/v1/projects/:slug/memory/:id', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, `/memory/${c.req.param('id')}`, user.id, { method: 'DELETE' });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Project files (read-only, for the console's preview panel) ──

app.post('/v1/projects/:slug/sync', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/sync', user.id, { method: 'POST' });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get('/v1/projects/:slug/files', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/files', user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get('/v1/projects/:slug/files/content', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, `/files/content?path=${encodeURIComponent(c.req.query('path') ?? '')}`, user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── KB share links (auth: project owner) ─────────────────────

app.get('/v1/projects/:slug/shares', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/shares', user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/v1/projects/:slug/shares', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/shares', user.id, {
    method: 'POST', body: JSON.stringify(await c.req.json()),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.delete('/v1/projects/:slug/shares/:shareId', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, `/shares/${c.req.param('shareId')}`, user.id, { method: 'DELETE' });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── WebSocket upgrade ───────────────────────────────────────

app.get('/v1/projects/:slug/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'websocket upgrade required' }, 426);
  }
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  return forwardToDO(stub, '/ws', user.id, { raw: c.req.raw });
});

export default app;
export type { Project, Ticket };
