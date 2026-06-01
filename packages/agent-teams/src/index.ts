/**
 * PAS Agent Teams Worker — entry point.
 * Routes HTTP to the per-project Durable Object.
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
  FAS_SESSION_SIGNING_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return null;
    try {
      const host = new URL(origin).hostname;
      if (host === 'localhost' || host === '127.0.0.1') return origin;
      if (host.endsWith('.proappstore.online') || host === 'proappstore.online') return origin;
      if (host.endsWith('.pages.dev') && host.includes('proappstore')) return origin;
      return null;
    } catch { return null; }
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'Upgrade'],
  maxAge: 600,
}));

// Auth middleware — all routes require a valid FAS session
app.use('/v1/*', async (c, next) => {
  const token = extractToken(c.req.raw);
  if (!token) return c.json({ error: 'missing bearer token' }, 401);

  const user = await verifyToken(c.env.FAS_API_BASE, token);
  if (!user) return c.json({ error: 'invalid or expired session' }, 401);

  c.set('user' as never, user);
  await next();
});

// Health
app.get('/health', (c) => c.json({ ok: true, version: '0.2.0', stage: 'do-live' }));

// ── Project lifecycle ───────────────────────────────────────

// Create a new project (creates DO instance)
app.post('/v1/projects', async (c) => {
  const user = c.get('user' as never) as { id: string };
  const body = await c.req.json<{ name: string; slug: string; costCapMonthlyUsd?: number }>();

  if (!body.name || !body.slug) return c.json({ error: 'name and slug required' }, 400);
  if (!/^[a-z][a-z0-9-]*$/.test(body.slug)) return c.json({ error: 'slug must be lowercase alphanumeric' }, 400);

  // Use slug as DO ID for deterministic routing
  const doId = c.env.PROJECT.idFromName(body.slug);
  const stub = c.env.PROJECT.get(doId);

  const res = await stub.fetch(new Request('https://do/project', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: body.name, slug: body.slug, ownerId: user.id, costCapMonthlyUsd: body.costCapMonthlyUsd }),
  }));

  return new Response(res.body, { status: res.status, headers: res.headers });
});

// Get project
app.get('/v1/projects/:slug', async (c) => {
  const slug = c.req.param('slug');
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(slug));
  const res = await stub.fetch(new Request('https://do/project'));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Role configs ────────────────────────────────────────────

app.get('/v1/projects/:slug/roles', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request('https://do/roles'));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.put('/v1/projects/:slug/roles', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request('https://do/roles', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Tickets ─────────────────────────────────────────────────

app.get('/v1/projects/:slug/tickets', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request('https://do/tickets'));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/v1/projects/:slug/tickets', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request('https://do/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get('/v1/projects/:slug/tickets/:id', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request(`https://do/tickets/${c.req.param('id')}`));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.patch('/v1/projects/:slug/tickets/:id', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request(`https://do/tickets/${c.req.param('id')}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/v1/projects/:slug/tickets/:id/transition', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request(`https://do/tickets/${c.req.param('id')}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Messages ────────────────────────────────────────────────

app.get('/v1/projects/:slug/tickets/:id/messages', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request(`https://do/tickets/${c.req.param('id')}/messages`));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/v1/projects/:slug/tickets/:id/messages', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request(`https://do/tickets/${c.req.param('id')}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Agent run ───────────────────────────────────────────────

app.post('/v1/projects/:slug/tickets/:id/run', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request(`https://do/tickets/${c.req.param('id')}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Cost ────────────────────────────────────────────────────

app.get('/v1/projects/:slug/cost', async (c) => {
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  const res = await stub.fetch(new Request('https://do/cost'));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── WebSocket upgrade ───────────────────────────────────────

app.get('/v1/projects/:slug/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'websocket upgrade required' }, 426);
  }
  const stub = c.env.PROJECT.get(c.env.PROJECT.idFromName(c.req.param('slug')));
  return stub.fetch(c.req.raw);
});

export default app;
export type { Project, Ticket };
