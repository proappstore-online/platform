/**
 * App tool CRUD — apps register MCP tools via `pas publish` (reads mcp.json).
 *
 * The MCP server reads them back through GET /v1/apps/:appId/tools for one
 * app (an app-scoped session registers that app's tools; the shared session
 * reaches them through list_app_tools / call_app_tool, #157). Callers outside
 * the app's team get only the allowlisted public view — never SQL (#158).
 * There is no cross-app listing: GET /v1/tools was retired (#193).
 */

import { Hono } from 'hono';
import { internalTokenOk } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { requireAppAccess, requireAppOwner } from '../lib/auth.js';
import { dataWorkerUrl } from '../lib/data-worker-url.js';

export const toolsRoutes = new Hono<{ Bindings: Env }>();

// ── Allowed SQL prefixes and safety rules ──────────────────────────
const ALLOWED_PREFIXES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const FORBIDDEN_KEYWORDS = ['CREATE', 'DROP', 'ALTER', 'PRAGMA', 'ATTACH', 'DETACH', 'VACUUM', 'REINDEX'];

/** Strip line and block comments, so a comment cannot hide a paren or a keyword from the scan. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ');
}

/**
 * The verb of the statement a leading CTE prefixes (#120).
 *
 * `WITH [RECURSIVE] name [(cols)] AS [NOT MATERIALIZED] ( … ) [, …] <verb> …`
 * is one statement in SQLite, and a recursive CTE in front of an INSERT or
 * UPDATE is the natural way to do server-side validation in a SQL-only action
 * surface. Skip the CTE list by tracking parenthesis depth — ignoring parens
 * inside single-quoted strings — and return the first token after it. Without
 * a WITH prefix the verb is simply the first token. Returns null when no verb
 * can be found (unterminated CTE, empty statement).
 */
export function mainStatementVerb(sql: string): string | null {
  const text = stripComments(sql).trim();
  const upper = text.toUpperCase();
  if (!/^WITH\b/.test(upper)) return /^[A-Z]+/.exec(upper)?.[0] ?? null;

  let i = /^WITH\s+RECURSIVE\b/.test(upper) ? 'WITH RECURSIVE'.length : 'WITH'.length;
  for (;;) {
    // Advance to this CTE's body: the first "(" that follows its AS keyword.
    const as = /\bAS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/g;
    as.lastIndex = i;
    const m = as.exec(upper);
    if (!m) return null;
    let depth = 0;
    let j = m.index + m[0].length - 1; // at the "("
    for (; j < text.length; j++) {
      const ch = text[j];
      if (ch === "'") {
        // Skip a string literal ('' is an escaped quote).
        j++;
        while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    if (depth !== 0) return null;
    i = j + 1;
    const rest = upper.slice(i).trimStart();
    if (rest.startsWith(',')) { i += upper.slice(i).indexOf(',') + 1; continue; }
    return /^[A-Z]+/.exec(rest)?.[0] ?? null;
  }
}

function validateSql(sql: string, operation: string): string | null {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  // The statement — after any leading WITH clause (#120) — must be one of the
  // allowed verbs. `WITH` itself is not a verb: a CTE only prefixes one.
  const verb = mainStatementVerb(trimmed);
  if (!verb || !ALLOWED_PREFIXES.includes(verb)) {
    return `SQL must start with ${ALLOWED_PREFIXES.join(', ')} (optionally preceded by a WITH / WITH RECURSIVE clause)`;
  }
  const isSelectLike = verb === 'SELECT';

  // No semicolons (prevent multi-statement)
  if (trimmed.includes(';')) {
    return 'SQL must not contain semicolons (no multi-statement)';
  }

  // No DDL keywords
  for (const kw of FORBIDDEN_KEYWORDS) {
    // Match as whole word
    if (new RegExp(`\\b${kw}\\b`, 'i').test(trimmed)) {
      return `SQL must not contain ${kw}`;
    }
  }

  // UPDATE/DELETE must have WHERE (verb of the main statement, so a CTE-prefixed
  // UPDATE is held to the same rule).
  if ((verb === 'UPDATE' || verb === 'DELETE') && !upper.includes('WHERE')) {
    return `${operation === 'execute' ? 'UPDATE/DELETE' : 'Mutation'} SQL must have a WHERE clause`;
  }

  // operation match
  if (operation === 'query' && !isSelectLike) {
    return 'operation "query" must use SELECT';
  }
  if (operation === 'execute' && isSelectLike) {
    return 'operation "execute" must not use SELECT (use "query" instead)';
  }

  return null; // valid
}

function literalLimit(sql: string): number | null {
  const withoutComments = sql
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const match = /\bLIMIT\s+(\d+)\b/i.exec(withoutComments);
  if (!match) return null;
  const tail = withoutComments.slice(match.index + match[0].length).trim();
  if (tail.startsWith(',')) return null;
  return Number(match[1]);
}

interface ToolParam {
  type: string;
  description?: string;
  optional?: boolean;
  default?: unknown;
  max?: number;
}

interface ToolManifest {
  name: string;
  description: string;
  operation: 'query' | 'execute' | 'batch';
  sql?: string;
  /** Batch tools: multiple statements, one shared params pool, executed
   *  atomically in a single D1 transaction on the data-worker. */
  statements?: string[];
  params: Record<string, ToolParam>;
  requires_auth?: boolean;
  auth?: {
    required?: boolean;
    platform_roles?: string[];
    app_roles?: string[];
    caller_unscoped?: { reason: string };
  };
  /** Stay pre-loaded on a large app's MCP session instead of being deferred to discovery (#117). */
  core?: boolean;
}

/** Above this many model-facing bytes the registration answers with a soft warning (#117). */
export const MANIFEST_BYTES_SOFT_LIMIT = 50_000;

/**
 * What a manifest costs the model, not the database (#117).
 *
 * The cap counts tools; the cost is bytes. And the bytes that matter are the ones an
 * MCP session publishes per tool — name, description and the params schema. SQL,
 * `operation`, `requires_auth` and `auth` never reach the model (`tool-loader.ts`
 * registers name + description + a zod shape built from `params`), so they are
 * excluded here on purpose: measuring the stored manifest overstates the cost by
 * roughly 60% (chess-academy: 115 kB stored vs ~73 kB on the wire).
 *
 * `estimatedTokens` is the usual ~4-bytes-per-token rule of thumb — good enough to
 * make a 120-tool manifest's per-call occupancy visible at registration, which is the
 * point; it is not a tokenizer.
 */
export function measureManifestCost(tools: ToolManifest[]): { bytes: number; bytesPerTool: number; estimatedTokens: number } {
  const enc = new TextEncoder();
  let bytes = 0;
  for (const tool of tools) {
    const modelFacing = { name: tool.name, description: tool.description, params: tool.params ?? {} };
    bytes += enc.encode(JSON.stringify(modelFacing)).byteLength;
  }
  return {
    bytes,
    bytesPerTool: tools.length ? Math.round(bytes / tools.length) : 0,
    estimatedTokens: Math.round(bytes / 4),
  };
}

function validateManifest(tool: ToolManifest): string | null {
  if (!tool.name || typeof tool.name !== 'string') return 'name is required';
  if (tool.core !== undefined && typeof tool.core !== 'boolean') return 'core must be a boolean';
  if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) return 'name must be lowercase alphanumeric with underscores';
  if (!tool.description || typeof tool.description !== 'string') return 'description is required';
  if (!['query', 'execute', 'batch'].includes(tool.operation)) return 'operation must be "query", "execute" or "batch"';
  if (tool.requires_auth !== true && tool.requires_auth !== false) return 'requires_auth must be explicitly true or false';

  let sqlStatements: string[];
  if (tool.operation === 'batch') {
    if (tool.sql !== undefined) return 'batch tools use statements, not sql';
    if (!Array.isArray(tool.statements) || tool.statements.length === 0) {
      return 'batch tools require a non-empty statements array';
    }
    if (tool.statements.length > 25) return 'max 25 statements per batch tool';
    if (tool.statements.some((s) => !s || typeof s !== 'string')) {
      return 'every statement must be a non-empty string';
    }
    sqlStatements = tool.statements;
  } else {
    if (tool.statements !== undefined) return 'only batch tools may declare statements';
    if (!tool.sql || typeof tool.sql !== 'string') return 'sql is required';
    sqlStatements = [tool.sql];
  }

  for (const stmt of sqlStatements) {
    // Batch member statements are writes (queries have nowhere to return).
    const sqlErr = validateSql(stmt, tool.operation === 'batch' ? 'execute' : tool.operation);
    if (sqlErr) return sqlErr;
  }

  if (tool.requires_auth === false) {
    if (tool.operation !== 'query') return 'requires_auth false is only allowed for query tools';
    const sql = sqlStatements[0] ?? '';
    if (/:__user_id\b/.test(sql)) return 'public query tools must not reference :__user_id';
    const limit = literalLimit(sql);
    if (limit === null) return 'public query tools must include a literal LIMIT of 500 or less';
    if (limit > 500) return 'public query tools must use LIMIT 500 or less';
  }

  // params must be an object (default to empty)
  if (tool.params !== undefined && tool.params !== null && typeof tool.params !== 'object') {
    return 'params must be an object';
  }
  const params = tool.params || {};

  // All :paramName in SQL must be declared in params (except magic params)
  const magicParams = new Set(['__user_id', '__now', '__uuid']);
  const sqlParams = sqlStatements.flatMap((stmt) =>
    [...stmt.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(m => m[1]!!),
  );
  const declaredParams = new Set([...Object.keys(params), ...magicParams]);
  for (const p of sqlParams) {
    if (!declaredParams.has(p)) return `SQL references :${p} but it is not declared in params`;
  }

  if (tool.auth !== undefined) {
    if (tool.auth === null || typeof tool.auth !== 'object' || Array.isArray(tool.auth)) {
      return 'auth must be an object';
    }
    if (tool.auth.platform_roles !== undefined && !isStringArray(tool.auth.platform_roles)) {
      return 'auth.platform_roles must be an array of strings';
    }
    if (tool.auth.app_roles !== undefined && !isStringArray(tool.auth.app_roles)) {
      return 'auth.app_roles must be an array of strings';
    }
    if (tool.requires_auth === false && (tool.auth.platform_roles?.length || tool.auth.app_roles?.length)) {
      return 'public query tools cannot declare auth roles';
    }
    if (tool.requires_auth === false && tool.auth.required === true) {
      return 'public query tools cannot require auth';
    }
    if (tool.auth.required === false && tool.requires_auth !== false) {
      return 'auth.required cannot be false for app data tools';
    }
  }

  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

/**
 * Schema coherence (#33 Phase 2): compile every action's SQL against the app's
 * LIVE schema (data worker `/validate` → `EXPLAIN`, no execution) so an action
 * that references a table/column that doesn't exist is caught at registration —
 * the deploy fails loud, naming the tool + column, instead of users hitting
 * `no such column` at runtime. Phase 1 applies migrations before this runs, so
 * the schema checked here is current.
 *
 * Hard-blocks ONLY on a definitive `no such column` / `no such table`. Any other
 * outcome — data worker unreachable, unexpected EXPLAIN error — SKIPS silently
 * and lets registration proceed, so transient infra never bricks a deploy
 * (defense-in-depth, not a new single point of failure).
 */
async function checkSchemaCoherence(
  env: Env,
  appId: string,
  tools: ToolManifest[],
): Promise<string[]> {
  // Flatten to individually-compilable statements, id'd back to their tool.
  const statements: { id: string; tool: string; sql: string; paramCount: number }[] = [];
  for (const tool of tools) {
    const raws = tool.operation === 'batch' ? (tool.statements ?? []) : [tool.sql ?? ''];
    raws.forEach((raw, i) => {
      let paramCount = 0;
      const sql = raw.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, () => { paramCount += 1; return '?'; });
      statements.push({ id: `${tool.name}#${i}`, tool: tool.name, sql, paramCount });
    });
  }
  if (statements.length === 0) return [];

  // Internal call: straight to the worker's workers.dev host (#153), not the
  // public data-* proxy hop. A missing DATA_WORKER_HOST throws a 503 here on
  // purpose — silently skipping validation would hide a platform misconfig.
  const validateUrl = dataWorkerUrl(env, appId, '/validate');
  let results: { id: string; ok: boolean; error?: string }[];
  try {
    const res = await fetch(validateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.INTERNAL_TOKEN ? { 'X-Internal-Token': env.INTERNAL_TOKEN } : {}),
      },
      body: JSON.stringify({ statements: statements.map(({ id, sql, paramCount }) => ({ id, sql, paramCount })) }),
    });
    if (!res.ok) return []; // couldn't validate — skip silently, don't block
    const data = await res.json() as { results?: typeof results };
    results = data.results ?? [];
  } catch {
    return []; // unreachable — skip silently
  }

  const toolById = new Map(statements.map((s) => [s.id, s.tool]));
  const errors: string[] = [];
  for (const r of results) {
    if (r.ok) continue;
    const err = r.error ?? '';
    // Only a definitive schema-existence failure blocks; anything else (custom
    // function, EXPLAIN quirk) is not proof of drift, so leave it to runtime.
    const m = /no such (column|table):?\s*([^\s]+)?/i.exec(err);
    if (m) {
      const tool = toolById.get(r.id) ?? r.id;
      errors.push(`tool "${tool}": ${m[0]}`);
    }
  }
  return errors;
}

/**
 * Validate a tools[] manifest and replace the app's registered tools (atomic
 * DELETE + INSERT). Shared by the owner-auth PUT (CLI `pas publish`) and the
 * internal POST (Agent Teams deploy stage). When `env` is supplied, also runs a
 * schema-coherence check (#33) that blocks registration if an action references
 * a missing table/column. Returns a status + payload the caller hands back as JSON.
 */
export async function replaceAppTools(
  db: D1Database,
  appId: string,
  tools: unknown,
  env?: Env,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!tools || !Array.isArray(tools)) {
    return { status: 400, payload: { error: 'tools array required' } };
  }
  // Abuse bound, not a design target. Data-heavy apps register one tool per
  // parameterized statement (chess-academy needs ~80), so 50 was too tight.
  if (tools.length > 120) {
    return { status: 400, payload: { error: 'max 120 tools per app' } };
  }
  for (const tool of tools as ToolManifest[]) {
    const err = validateManifest(tool);
    if (err) return { status: 400, payload: { error: `tool "${tool?.name}": ${err}` } };
  }

  // Security lint: every statement of an authenticated tool — reads included —
  // must be scoped to the caller via :__user_id, or the tool must declare an
  // explicit auth.caller_unscoped exemption (with a non-empty reason string).
  // An unscoped read lets any signed-in user read every tenant's rows. Public
  // (requires_auth: false) tools are exempt. Failure is a hard rejection, not a
  // warning, so a misconfigured tool cannot be registered at all.
  const scopeErrors: string[] = [];
  for (const tool of tools as ToolManifest[]) {
    if (tool.requires_auth === false) continue; // public query path — no user identity expected
    const hasCallerUnscoped =
      typeof tool.auth?.caller_unscoped?.reason === 'string' &&
      tool.auth.caller_unscoped.reason.trim().length > 0;
    if (hasCallerUnscoped) continue;
    const stmts = tool.operation === 'batch' ? (tool.statements ?? []) : [tool.sql ?? ''];
    stmts.forEach((stmt, idx) => {
      if (!stmt.includes(':__user_id')) {
        const location =
          tool.operation === 'batch' ? `"${tool.name}" statement[${idx}]` : `"${tool.name}"`;
        scopeErrors.push(
          `${location}: statement has no :__user_id and no auth.caller_unscoped exemption`,
        );
      }
    });
  }
  if (scopeErrors.length > 0) {
    return {
      status: 400,
      payload: {
        error: 'statements must include :__user_id or declare auth.caller_unscoped',
        details: scopeErrors,
      },
    };
  }

  // Schema coherence (#33): reject actions whose SQL references a missing
  // table/column, before we persist them. Runs against the just-migrated schema
  // (Phase 1 migrates before register). Skipped when env is absent (direct unit
  // tests of this fn) or when the check can't reach the data worker.
  if (env) {
    const coherenceErrors = await checkSchemaCoherence(env, appId, tools as ToolManifest[]);
    if (coherenceErrors.length > 0) {
      return {
        status: 422,
        payload: {
          error: `schema coherence: ${coherenceErrors.length} action(s) reference schema that doesn't exist`,
          details: coherenceErrors,
        },
      };
    }
  }

  const now = Date.now();
  const stmts = [
    db.prepare('DELETE FROM app_tools WHERE app_id = ?').bind(appId),
    ...(tools as ToolManifest[]).map(tool =>
      db.prepare(
        'INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(appId, tool.name, JSON.stringify(tool), now, now),
    ),
  ];
  await db.batch(stmts);

  // Report the model-facing cost beside the count (#117). A soft warning above the
  // threshold — never a rejection: the deploy workflow prints `warnings[]` as
  // `::warning::mcp.json: …`, so the author sees the number where the deploy is.
  const cost = measureManifestCost(tools as ToolManifest[]);
  const warnings: string[] =
    cost.bytes > MANIFEST_BYTES_SOFT_LIMIT
      ? [
          `Manifest model-facing payload is ${cost.bytes} bytes (~${cost.estimatedTokens} tokens) across ${tools.length} tool(s); ` +
            'every MCP session on this app carries it in context on every call — consider slimming descriptions or adopting progressive disclosure',
        ]
      : [];
  return {
    status: 200,
    payload: { ok: true, registered: tools.length, ...cost, warnings },
  };
}

// ── PUT /v1/apps/:appId/tools — bulk register tools from mcp.json ──
toolsRoutes.put('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);

  const body = await c.req.json<{ tools?: ToolManifest[] }>().catch(() => null);
  const { status, payload } = await replaceAppTools(c.env.DB, appId, body?.tools, c.env);
  return c.json(payload, status as 200 | 400 | 422);
});

// ── POST /v1/apps/:appId/tools/internal — register tools service-to-service ──
// Called by the Agent Teams deploy stage over the PAS_BACKEND binding so
// agent-built apps register their mcp.json the same way `pas publish` does for
// CLI apps. Auth is the shared INTERNAL_TOKEN (the agent flow has no session).
// An empty/missing tools array clears the app's tools (the manifest was removed).
toolsRoutes.post('/apps/:appId/tools/internal', async (c) => {
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const appId = c.req.param('appId')!;
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    return c.json({ error: 'invalid app id' }, 400);
  }
  const body = await c.req.json<{ tools?: ToolManifest[] }>().catch(() => null);
  const { status, payload } = await replaceAppTools(c.env.DB, appId, body?.tools ?? [], c.env);
  return c.json(payload, status as 200 | 400 | 422);
});

/**
 * SECURITY (#158): what an unauthenticated caller may see of a manifest —
 * everything needed to CALL a tool, never how it is implemented. The SQL is
 * the app's authorization model (docs/mcp-app-tools.md), and app repos are
 * private, so it goes only to the app's team.
 *
 * An allowlist, not a `delete m.sql` denylist: a field added to the manifest
 * later (statements, auth.caller_unscoped.reason) is private until listed here.
 */
function publicToolView(m: ToolManifest) {
  return {
    name: m.name,
    description: m.description,
    operation: m.operation,
    params: m.params,
    requires_auth: m.requires_auth,
    // Which tools stay resident on a large app's MCP session (#117) — not sensitive.
    ...(m.core !== undefined ? { core: m.core } : {}),
    ...(m.auth
      ? { auth: { required: m.auth.required, platform_roles: m.auth.platform_roles, app_roles: m.auth.app_roles } }
      : {}),
  };
}

// ── GET /v1/apps/:appId/tools — list tools for one app ──────────
//
// Public: names, descriptions, params (the MCP's per-app session calls this
// with no credential and never reads the SQL). Full manifests, SQL included,
// only for the app's team — creator, any team_members role, or a platform
// admin — which is what the console's "show SQL" sends a bearer for.
toolsRoutes.get('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  const teamMember = await requireAppAccess(c, appId, 'viewer').then(() => true, () => false);

  const result = await c.env.DB.prepare(
    'SELECT name, manifest, updated_at FROM app_tools WHERE app_id = ? ORDER BY name',
  ).bind(appId).all<{ name: string; manifest: string; updated_at: number }>();

  const tools: unknown[] = [];
  for (const r of result.results ?? []) {
    let manifest: ToolManifest;
    try {
      manifest = JSON.parse(r.manifest);
    } catch { continue; /* skip corrupted row */ }
    tools.push(
      teamMember
        ? { ...manifest, updated_at: r.updated_at }
        : { ...publicToolView(manifest), updated_at: r.updated_at },
    );
  }

  // The full variant is per-caller; no cache layer may hand it to anyone else.
  if (teamMember) c.header('Cache-Control', 'private, no-store');
  return c.json({ tools });
});

// ── DELETE /v1/apps/:appId/tools — remove all tools for an app ──
toolsRoutes.delete('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  await c.env.DB.prepare('DELETE FROM app_tools WHERE app_id = ?').bind(appId).run();
  return c.json({ ok: true });
});

// ── DELETE /v1/apps/:appId/tools/:name — remove one tool ─────────
toolsRoutes.delete('/apps/:appId/tools/:name', async (c) => {
  const appId = c.req.param('appId')!;
  const name = c.req.param('name')!;
  await requireAppOwner(c, appId);
  await c.env.DB.prepare('DELETE FROM app_tools WHERE app_id = ? AND name = ?').bind(appId, name).run();
  return c.json({ ok: true });
});
