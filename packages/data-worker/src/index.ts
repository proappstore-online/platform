import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

interface Env {
  DB: D1Database;
  APP_ID: string;
  FAS_API_BASE: string;
}

interface FasUser {
  id: string;
  login: string;
}

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return null;
      try {
        const host = new URL(origin).hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1') return origin;
        if (host.endsWith('.proappstore.online') || host === 'proappstore.online') return origin;
        if (host.endsWith('.pages.dev')) return origin;
        return null;
      } catch {
        return null;
      }
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  }),
);

// ---------------------------------------------------------------------------
// Auth (with 60s in-memory cache to avoid FAS API round-trip on every query)
// ---------------------------------------------------------------------------

const authCache = new Map<string, { user: FasUser; expires: number }>();
const AUTH_CACHE_TTL_MS = 60_000;

async function requireUser(c: { req: { header(name: string): string | undefined }; env: Env }): Promise<FasUser> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'missing bearer token' });
  }
  const token = header.slice(7);

  // Check cache
  const cached = authCache.get(token);
  if (cached && cached.expires > Date.now()) {
    return cached.user;
  }

  const fasBase = c.env.FAS_API_BASE || 'https://api.freeappstore.online';
  const response = await fetch(`${fasBase}/v1/auth/me`, {
    headers: { Authorization: header },
  });
  if (!response.ok) {
    authCache.delete(token);
    throw new HTTPException(401, { message: 'invalid session' });
  }
  const user = (await response.json()) as FasUser;

  // Cache for 60s
  authCache.set(token, { user, expires: Date.now() + AUTH_CACHE_TTL_MS });

  // Evict stale entries (prevent unbounded growth)
  if (authCache.size > 100) {
    const now = Date.now();
    for (const [key, entry] of authCache) {
      if (entry.expires <= now) authCache.delete(key);
    }
  }

  return user;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

interface SqlPayload {
  sql: string;
  params?: unknown[];
}

function validateSql(body: unknown): SqlPayload {
  const obj = body as Record<string, unknown>;
  if (typeof obj.sql !== 'string' || obj.sql.trim() === '') {
    throw new HTTPException(400, { message: 'sql must be a non-empty string' });
  }
  if (obj.params !== undefined && !Array.isArray(obj.params)) {
    throw new HTTPException(400, { message: 'params must be an array' });
  }
  const payload: SqlPayload = { sql: obj.sql };
  if (Array.isArray(obj.params)) payload.params = obj.params;
  return payload;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (c) => c.json({ ok: true }));

app.get('/tables', async (c) => {
  await requireUser(c);
  const result = await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  return c.json(result.results.map((r) => r.name));
});

app.post('/query', async (c) => {
  await requireUser(c);
  const body = await c.req.json();
  const { sql, params } = validateSql(body);
  const start = Date.now();
  const stmt = params ? c.env.DB.prepare(sql).bind(...params) : c.env.DB.prepare(sql);
  const result = await stmt.all();
  return c.json({
    rows: result.results,
    meta: { changes: result.meta.changes, duration: Date.now() - start },
  });
});

app.post('/execute', async (c) => {
  await requireUser(c);
  const body = await c.req.json();
  const { sql, params } = validateSql(body);
  const start = Date.now();
  const stmt = params ? c.env.DB.prepare(sql).bind(...params) : c.env.DB.prepare(sql);
  const result = await stmt.run();
  return c.json({
    meta: {
      changes: result.meta.changes,
      duration: Date.now() - start,
      last_row_id: result.meta.last_row_id,
    },
  });
});

app.post('/batch', async (c) => {
  await requireUser(c);
  const body = await c.req.json<{ statements: unknown[] }>();
  if (!Array.isArray(body.statements) || body.statements.length === 0) {
    throw new HTTPException(400, { message: 'statements must be a non-empty array' });
  }
  const stmts = body.statements.map((raw) => {
    const { sql, params } = validateSql(raw);
    return params ? c.env.DB.prepare(sql).bind(...params) : c.env.DB.prepare(sql);
  });
  const results = await c.env.DB.batch(stmts);
  return c.json({
    results: results.map((r) => ({
      rows: r.results,
      meta: { changes: r.meta.changes, last_row_id: r.meta.last_row_id },
    })),
  });
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error('Unhandled error:', err);
  return c.json({ error: 'internal server error' }, 500);
});

export default app;
