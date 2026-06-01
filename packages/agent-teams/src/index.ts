/**
 * PAS Agent Teams Worker — entry point.
 * Routes HTTP to the per-project Durable Object.
 * Security: auth middleware + ownership check on every DO request.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Project, Ticket } from './types.ts';
import { verifyToken, extractToken } from './auth.ts';
export { ProjectDO } from './project-do.ts';

export type Bindings = {
  PROJECT: DurableObjectNamespace;
  AGENT_STORAGE: R2Bucket;
  PAS_BACKEND: Fetcher;
  FAS_API_BASE: string;
  PAS_API_BASE: string;
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
  opts?: { method?: string; body?: string; raw?: Request },
): Promise<Response> {
  if (opts?.raw) {
    // For WebSocket upgrades, clone the request with the user ID header
    const headers = new Headers(opts.raw.headers);
    headers.set('X-User-Id', userId);
    return stub.fetch(new Request(opts.raw.url, { headers, method: opts.raw.method }));
  }
  return stub.fetch(new Request(`https://do${path}`, {
    method: opts?.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': userId,
    },
    ...(opts?.body ? { body: opts.body } : {}),
  }));
}

// ── Project lifecycle ───────────────────────────────────────

// Create a new project
app.post('/v1/projects', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const body = await c.req.json<{ name: string; slug: string; costCapMonthlyUsd?: number }>();

  if (!body.name || !body.slug) return c.json({ error: 'name and slug required' }, 400);
  if (!/^[a-z][a-z0-9-]{1,56}$/.test(body.slug)) return c.json({ error: 'slug must be 2-58 chars, lowercase alphanumeric with hyphens' }, 400);
  if (body.name.length > 100) return c.json({ error: 'name too long (max 100)' }, 400);

  // Validate cost cap range
  const cap = body.costCapMonthlyUsd ?? 50.0;
  if (cap < 1 || cap > 1000) return c.json({ error: 'costCapMonthlyUsd must be 1-1000' }, 400);

  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(body.slug));
  const res = await forwardToDO(stub, '/project', user.id, {
    method: 'PUT',
    body: JSON.stringify({ name: body.name, slug: body.slug, ownerId: user.id, costCapMonthlyUsd: cap }),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// Get project
app.get('/v1/projects/:slug', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await forwardToDO(stub, '/project', user.id);
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
