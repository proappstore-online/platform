import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

interface Env {
  DB: D1Database;
  APP_ID: string;
  /** PAS credential-account signing key. */
  SESSION_SIGNING_KEY: string;
  /** PAS platform API base (e.g. https://api.proappstore.online) — used to
   *  authorize the caller against this worker's APP_ID. */
  API_BASE: string;
  /** Shared platform secret. A request bearing `X-Internal-Token` equal to this
   *  value is the platform actions-executor — the SQL is already prepared and
   *  the caller identity injected server-side (see backend routes/actions.ts),
   *  so it bypasses the per-user ownership check. When unset the internal path
   *  is inert and every request falls back to the session+ownership check
   *  (fail-closed). */
  INTERNAL_TOKEN?: string;
  /** Service binding to the platform API worker (proappstore-api). Required:
   *  api.proappstore.online is a route-mapped hostname, and same-zone Worker
   *  subrequests bypass route-mapped Workers entirely — a plain fetch() never
   *  reaches the API and the fail-closed auth check 403s every caller. */
  API: Fetcher;
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
// Auth — local JWT verification (no FAS dependency)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

async function verifySessionLocal(
  token: string,
  signingKey: string,
): Promise<{ uid: string; login: string } | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(signingKey) as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, enc.encode(body) as BufferSource),
    );
    let b = '';
    for (const byte of expected) b += String.fromCharCode(byte);
    const expectedStr = btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (sig.length !== expectedStr.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expectedStr.charCodeAt(i);
    if (diff !== 0) return null;
    const padded = body.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((body.length + 3) % 4);
    const json = dec.decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    const claims = JSON.parse(json) as { uid?: string; login?: string; exp?: number };
    if (!claims.uid) return null;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return { uid: claims.uid, login: claims.login ?? claims.uid };
  } catch {
    return null;
  }
}

async function requireUser(c: { req: { header(name: string): string | undefined }; env: Env }): Promise<FasUser> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'missing bearer token' });
  }
  const token = header.slice(7);
  const claims = await verifySessionLocal(token, c.env.SESSION_SIGNING_KEY);
  if (!claims) {
    throw new HTTPException(401, { message: 'invalid session' });
  }

  // SECURITY: a valid platform session is NOT enough. This worker holds ONE
  // app's D1 and runs caller-supplied SQL (/query, /execute, /batch, /migrate),
  // so without an app-scoped authorization check any signed-in PAS user could
  // read or DROP another app's database by calling that app's data-worker.
  // The platform `apps`/`team_members` tables live in the main API (not here),
  // so authorize against this worker's APP_ID via the user's own /v1/apps.
  // Fail closed on any error.
  let authorized = false;
  try {
    const res = await c.env.API.fetch(`${c.env.API_BASE}/v1/apps`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { apps?: Array<{ id: string }> };
      authorized = (data.apps ?? []).some((a) => a.id === c.env.APP_ID);
    }
  } catch {
    authorized = false;
  }
  if (!authorized) {
    throw new HTTPException(403, { message: 'not authorized for this app' });
  }

  return { id: claims.uid, login: claims.login };
}

/**
 * True when the request carries the shared platform secret — i.e. it is the
 * backend actions-executor forwarding prepared, role-checked SQL (identity
 * already injected via `__user_id`). Unset INTERNAL_TOKEN ⇒ always false ⇒
 * fail-closed. Constant secret comparison is sufficient here (the value never
 * reaches a browser; the host strips any client-supplied X-Internal-Token).
 */
function isInternal(c: { req: { header(name: string): string | undefined }; env: Env }): boolean {
  const provided = c.req.header('X-Internal-Token');
  return !!c.env.INTERNAL_TOKEN && provided === c.env.INTERNAL_TOKEN;
}

/**
 * Authorization gate for every SQL route.
 *  - Trusted internal path (actions-executor): allowed — SQL is platform-prepared.
 *  - Direct raw-SQL path (browser `app.db`): must be the app owner / developer
 *    (session + `/v1/apps` ownership check). Ordinary end-users fail closed.
 */
async function authorize(c: { req: { header(name: string): string | undefined }; env: Env }): Promise<void> {
  if (isInternal(c)) return;
  await requireUser(c);
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
  await authorize(c);
  const result = await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  return c.json(result.results.map((r) => r.name));
});

app.post('/query', async (c) => {
  await authorize(c);
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
  await authorize(c);
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
  await authorize(c);
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
// Migrations
// ---------------------------------------------------------------------------

app.post('/migrate', async (c) => {
  await authorize(c);
  const body = await c.req.json<{ migrations: { name: string; sql: string }[] }>();
  if (!Array.isArray(body.migrations) || body.migrations.length === 0) {
    throw new HTTPException(400, { message: 'migrations must be a non-empty array of {name, sql}' });
  }

  // Ensure migrations tracking table exists
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  ).run();

  // Get already-applied migrations
  const applied = await c.env.DB.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  const appliedSet = new Set(applied.results.map((r) => r.name));

  // Run pending migrations in order
  const ran: string[] = [];
  for (const m of body.migrations) {
    if (appliedSet.has(m.name)) continue;
    // Split on semicolons to handle multi-statement migrations
    const statements = m.sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
    for (const stmt of statements) {
      await c.env.DB.prepare(stmt).run();
    }
    await c.env.DB.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').bind(m.name, Date.now()).run();
    ran.push(m.name);
  }

  return c.json({ applied: ran, already: [...appliedSet] });
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
