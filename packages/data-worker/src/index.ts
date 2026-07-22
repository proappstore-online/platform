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

function corsOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return origin;
  } catch {
    return null;
  }
}

function setCorsHeaders(res: Response, origin: string | null): void {
  if (!origin) return;
  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

app.use(
  '*',
  cors({
    // The data worker is app-authorized by bearer session or X-Internal-Token
    // on every SQL route. CORS only decides which browser origins can receive
    // those authorized responses; custom BYO app domains are not knowable from
    // this per-app worker without adding a platform round trip to preflight.
    origin: corsOrigin,
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

// Team role ladder (mirrors the backend's TEAM_ROLES; vendored — data-worker
// depends on no other package at runtime). Index = privilege rank.
const TEAM_ROLES = ['viewer', 'po', 'developer', 'admin', 'owner'] as const;
function roleRank(role: string | null | undefined): number {
  const i = TEAM_ROLES.indexOf(role as (typeof TEAM_ROLES)[number]);
  return i === -1 ? 0 : i; // unknown/absent → least privilege
}

async function requireUser(c: { req: { header(name: string): string | undefined }; env: Env }): Promise<FasUser & { teamRole: string }> {
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
  // so authorize against this worker's APP_ID via the user's own /v1/apps —
  // which now also carries the caller's effective team role, so callers can be
  // gated by role (viewer < po < developer < admin < owner), not just
  // membership. Fail closed on any error.
  let teamRole: string | null = null;
  try {
    const res = await c.env.API.fetch(`${c.env.API_BASE}/v1/apps`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { apps?: Array<{ id: string; team_role?: string }> };
      const app = (data.apps ?? []).find((a) => a.id === c.env.APP_ID);
      teamRole = app ? (app.team_role ?? 'viewer') : null;
    }
  } catch {
    teamRole = null;
  }
  if (!teamRole) {
    throw new HTTPException(403, { message: 'not authorized for this app' });
  }

  return { id: claims.uid, login: claims.login, teamRole };
}

/**
 * True when the request carries the shared platform secret — i.e. it is the
 * backend actions-executor forwarding prepared, role-checked SQL (identity
 * already injected via `__user_id`). Unset INTERNAL_TOKEN ⇒ always false ⇒
 * fail-closed. Uses a constant-time compare so the token isn't recoverable via
 * a response-timing oracle (the data-worker is reachable directly at its
 * data-<app>.proappstore.online custom domain).
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isInternal(c: { req: { header(name: string): string | undefined }; env: Env }): boolean {
  const provided = c.req.header('X-Internal-Token');
  return !!c.env.INTERNAL_TOKEN && typeof provided === 'string'
    && timingSafeEqualStr(provided, c.env.INTERNAL_TOKEN);
}

/**
 * Authorization gate for every SQL route.
 *  - Trusted internal path (actions-executor): allowed — SQL is platform-prepared
 *    and already role-checked by the backend.
 *  - Direct raw-SQL path (browser `app.db`): the caller's team role must meet
 *    `minRole`. Raw SQL can mutate regardless of endpoint, so reads and writes
 *    require `developer`; schema migrations require `owner`. Ordinary end-users
 *    (viewer/po) fail closed and must go through registered actions instead.
 */
async function authorize(
  c: { req: { header(name: string): string | undefined }; env: Env },
  minRole: 'developer' | 'owner',
): Promise<void> {
  if (isInternal(c)) return;
  const user = await requireUser(c);
  if (roleRank(user.teamRole) < roleRank(minRole)) {
    throw new HTTPException(403, {
      message: `raw SQL requires the '${minRole}' role (you have '${user.teamRole}') — use registered actions instead`,
    });
  }
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
  await authorize(c, 'developer');
  const result = await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  return c.json(result.results.map((r) => r.name));
});

app.post('/query', async (c) => {
  await authorize(c, 'developer');
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
  await authorize(c, 'developer');
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
  await authorize(c, 'developer');
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

/**
 * Split a migration body into statements on TOP-LEVEL semicolons only. A naive
 * split(';') corrupts any statement with a semicolon inside a string literal
 * (`'a;b'`) or inside a CREATE TRIGGER ... BEGIN ...; ...; END body. This
 * respects '…' "…" `…` [ … ] quoting, -- line + /* *\/ block comments, and
 * BEGIN/END nesting (trigger/compound bodies).
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let beginDepth = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    // /* block comment */
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    // quoted string / quoted identifier — copy verbatim, honoring '' escaping
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      buf += ch;
      i++;
      while (i < n) {
        const c = sql[i]!;
        buf += c;
        if (c === quote) {
          if (sql[i + 1] === quote) { buf += quote; i += 2; continue; } // escaped
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // [bracket identifier]
    if (ch === '[') {
      const close = sql.indexOf(']', i + 1);
      const end = close === -1 ? n : close + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    // BEGIN / END keyword nesting (only at a word boundary, outside quotes)
    if (ch === 'b' || ch === 'B' || ch === 'e' || ch === 'E') {
      const prev = buf.length ? buf[buf.length - 1]! : ' ';
      if (/[^a-zA-Z0-9_]/.test(prev)) {
        const rest = sql.slice(i);
        const beginM = /^begin\b/i.exec(rest);
        if (beginM) { beginDepth++; buf += beginM[0]; i += beginM[0].length; continue; }
        const endM = /^end\b/i.exec(rest);
        if (endM) { if (beginDepth > 0) beginDepth--; buf += endM[0]; i += endM[0].length; continue; }
      }
    }
    if (ch === ';' && beginDepth === 0) {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

app.post('/migrate', async (c) => {
  await authorize(c, 'owner');
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
    // Split into statements on top-level semicolons only (safe for triggers +
    // string literals containing ';').
    const statements = splitSqlStatements(m.sql);
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]!;
      try {
        await c.env.DB.prepare(stmt).run();
      } catch (e) {
        return c.json({
          error: 'migration statement failed',
          migration: m.name,
          statementIndex: i,
          statement: stmt.slice(0, 500),
          detail: e instanceof Error ? e.message : String(e),
          applied: ran,
          already: [...appliedSet],
        }, 422);
      }
    }
    try {
      await c.env.DB.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').bind(m.name, Date.now()).run();
    } catch (e) {
      return c.json({
        error: 'migration tracking insert failed',
        migration: m.name,
        detail: e instanceof Error ? e.message : String(e),
        applied: ran,
        already: [...appliedSet],
      }, 500);
    }
    ran.push(m.name);
  }

  return c.json({ applied: ran, already: [...appliedSet] });
});

// ---------------------------------------------------------------------------
// Schema coherence validation (#33 Phase 2)
// ---------------------------------------------------------------------------

/**
 * Compile each candidate statement against the LIVE schema WITHOUT executing it,
 * so the platform can reject an app action whose SQL references a table/column
 * that doesn't exist (the drift that surfaced to users as `no such column`).
 * `EXPLAIN <sql>` runs SQLite's prepare step — full name resolution — then
 * returns the opcode listing instead of running the query, so nothing mutates.
 * Params are bound to NULL purely to satisfy the bind-count; their values are
 * irrelevant to name resolution. Internal-only (raw SQL, no session path).
 */
app.post('/validate', async (c) => {
  if (!isInternal(c)) throw new HTTPException(403, { message: 'forbidden' });
  const body = await c.req.json<{ statements: { id: string; sql: string; paramCount?: number }[] }>();
  if (!Array.isArray(body.statements)) {
    throw new HTTPException(400, { message: 'statements must be an array of {id, sql, paramCount}' });
  }
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const s of body.statements) {
    try {
      const binds = Array(Math.max(0, s.paramCount ?? 0)).fill(null);
      const stmt = c.env.DB.prepare(`EXPLAIN ${s.sql}`);
      await (binds.length ? stmt.bind(...binds) : stmt).all();
      results.push({ id: s.id, ok: true });
    } catch (e) {
      results.push({ id: s.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return c.json({ results });
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  const origin = corsOrigin(c.req.header('Origin'));
  if (err instanceof HTTPException) {
    const res = c.json({ error: err.message }, err.status);
    setCorsHeaders(res, origin);
    return res;
  }
  console.error('Unhandled error:', err);
  const res = c.json({ error: 'internal server error' }, 500);
  setCorsHeaders(res, origin);
  return res;
});

export default app;
