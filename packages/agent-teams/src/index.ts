/**
 * PAS Agent Teams Worker — entry point.
 * Routes HTTP to the per-project Durable Object.
 * Security: auth middleware + ownership check on every DO request.
 */

import { Hono } from 'hono';
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
  allowHeaders: ['Authorization', 'Content-Type'],
  maxAge: 600,
}));

// Auth middleware — all /v1/* routes require a valid FAS session
app.use('/v1/*', async (c, next) => {
  const token = extractToken(c.req.raw);
  if (!token) return c.json({ error: 'missing bearer token' }, 401);

  const user = await verifyToken(c.env.FAS_API_BASE, token);
  if (!user) return c.json({ error: 'invalid or expired session' }, 401);

  c.set('user' as never, user);
  c.set('userToken' as never, token);
  await next();
});

// Health
app.get('/health', (c) => c.json({ ok: true, version: '0.3.0', stage: 'security-hardened' }));

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
app.get('/v1/projects/:slug', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/project', user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Play/Pause ──────────────────────────────────────────────

app.post('/v1/projects/:slug/play', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const userToken = c.get('userToken' as never) as string | undefined;
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/project/play', user.id, { method: 'POST', userToken });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/v1/projects/:slug/pause', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/project/pause', user.id, { method: 'POST' });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Chat (PO agent) ─────────────────────────────────────────

app.post('/v1/projects/:slug/chat', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/chat', user.id, {
    method: 'POST',
    body: JSON.stringify(await c.req.json()),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get('/v1/projects/:slug/chat/history', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/chat/history', user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.delete('/v1/projects/:slug/chat/history', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/chat/history', user.id, { method: 'DELETE' });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Role configs ────────────────────────────────────────────

app.get('/v1/projects/:slug/roles', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/roles', user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.put('/v1/projects/:slug/roles', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/roles', user.id, {
    method: 'PUT',
    body: JSON.stringify(await c.req.json()),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Tickets ─────────────────────────────────────────────────

app.get('/v1/projects/:slug/tickets', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/tickets', user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/v1/projects/:slug/tickets', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const body = await c.req.json<{ title: string; rawIdea: string }>();

  // Input validation
  if (!body.title || body.title.length > 200) return c.json({ error: 'title required (max 200 chars)' }, 400);
  if (!body.rawIdea || body.rawIdea.length > 65536) return c.json({ error: 'rawIdea required (max 64KB)' }, 400);

  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/tickets', user.id, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get('/v1/projects/:slug/tickets/:id', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, `/tickets/${c.req.param('id')}`, user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.patch('/v1/projects/:slug/tickets/:id', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, `/tickets/${c.req.param('id')}`, user.id, {
    method: 'PATCH',
    body: JSON.stringify(await c.req.json()),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.delete('/v1/projects/:slug/tickets/:id', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, `/tickets/${c.req.param('id')}`, user.id, { method: 'DELETE' });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/v1/projects/:slug/tickets/:id/transition', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, `/tickets/${c.req.param('id')}/transition`, user.id, {
    method: 'POST',
    body: JSON.stringify(await c.req.json()),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Messages ────────────────────────────────────────────────

app.get('/v1/projects/:slug/tickets/:id/messages', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, `/tickets/${c.req.param('id')}/messages`, user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/v1/projects/:slug/tickets/:id/messages', async (c) => {
  const user = c.get('user' as never) as { id: string };

  // Body size limit (1MB)
  const contentLength = parseInt(c.req.header('Content-Length') ?? '0', 10);
  if (contentLength > 1_048_576) return c.json({ error: 'message body too large (max 1MB)' }, 413);

  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, `/tickets/${c.req.param('id')}/messages`, user.id, {
    method: 'POST',
    body: JSON.stringify(await c.req.json()),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Agent run ───────────────────────────────────────────────

app.post('/v1/projects/:slug/tickets/:id/run', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, `/tickets/${c.req.param('id')}/run`, user.id, {
    method: 'POST',
    body: JSON.stringify(await c.req.json()),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Cost ────────────────────────────────────────────────────

app.get('/v1/projects/:slug/cost', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/cost', user.id);
  return new Response(res.body, { status: res.status, headers: res.headers });
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
