/**
 * App tool CRUD — apps register MCP tools via `pas publish` (reads mcp.json).
 * The MCP server fetches tools from GET /v1/tools to register them dynamically.
 */

import { Hono } from 'hono';
import { internalTokenOk } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { requireAppOwner } from '../lib/auth.js';

export const toolsRoutes = new Hono<{ Bindings: Env }>();

// ── Allowed SQL prefixes and safety rules ──────────────────────────
const ALLOWED_PREFIXES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const FORBIDDEN_KEYWORDS = ['CREATE', 'DROP', 'ALTER', 'PRAGMA', 'ATTACH', 'DETACH', 'VACUUM', 'REINDEX'];

function validateSql(sql: string, operation: string): string | null {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  // Must start with an allowed prefix
  if (!ALLOWED_PREFIXES.some(p => upper.startsWith(p))) {
    return `SQL must start with ${ALLOWED_PREFIXES.join(', ')}`;
  }

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

  // UPDATE/DELETE must have WHERE
  if ((upper.startsWith('UPDATE') || upper.startsWith('DELETE')) && !upper.includes('WHERE')) {
    return `${operation === 'execute' ? 'UPDATE/DELETE' : 'Mutation'} SQL must have a WHERE clause`;
  }

  // operation match
  if (operation === 'query' && !upper.startsWith('SELECT')) {
    return 'operation "query" must use SELECT';
  }
  if (operation === 'execute' && upper.startsWith('SELECT')) {
    return 'operation "execute" must not use SELECT (use "query" instead)';
  }

  return null; // valid
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
  };
}

function validateManifest(tool: ToolManifest): string | null {
  if (!tool.name || typeof tool.name !== 'string') return 'name is required';
  if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) return 'name must be lowercase alphanumeric with underscores';
  if (!tool.description || typeof tool.description !== 'string') return 'description is required';
  if (!['query', 'execute', 'batch'].includes(tool.operation)) return 'operation must be "query", "execute" or "batch"';
  if (tool.requires_auth !== true) return 'requires_auth must be true for app data tools';

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
    if (tool.auth.required === false) {
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

  let results: { id: string; ok: boolean; error?: string }[];
  try {
    const res = await fetch(`https://data-${appId}.proappstore.online/validate`, {
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

  // Security lint (non-blocking): a write statement with no :__user_id has
  // neither identity scoping nor a caller guard — any signed-in user can run
  // it against arbitrary rows. Legitimate exceptions exist (e.g. consuming a
  // join code by its unguessable id), so this warns rather than rejects; the
  // deploy workflow surfaces the warnings in the run log.
  const warnings: string[] = [];
  for (const tool of tools as ToolManifest[]) {
    const stmts = tool.operation === 'batch' ? (tool.statements ?? []) : [tool.sql ?? ''];
    for (const stmt of stmts) {
      const upper = stmt.trim().toUpperCase();
      const isWrite = upper.startsWith('UPDATE') || upper.startsWith('DELETE') || upper.startsWith('INSERT');
      if (isWrite && !stmt.includes(':__user_id')) {
        warnings.push(
          `${tool.name}: write statement has no :__user_id — no identity scoping or caller guard; any signed-in user can run it`,
        );
      }
    }
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
          ...(warnings.length ? { warnings } : {}),
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
  return {
    status: 200,
    payload: { ok: true, registered: tools.length, ...(warnings.length ? { warnings } : {}) },
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

// ── GET /v1/apps/:appId/tools — list tools for one app ──────────
toolsRoutes.get('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  const result = await c.env.DB.prepare(
    'SELECT name, manifest, updated_at FROM app_tools WHERE app_id = ? ORDER BY name',
  ).bind(appId).all<{ name: string; manifest: string; updated_at: number }>();

  const tools: unknown[] = [];
  for (const r of result.results ?? []) {
    try {
      tools.push({ name: r.name, ...JSON.parse(r.manifest), updated_at: r.updated_at });
    } catch { /* skip corrupted row */ }
  }

  return c.json({ tools });
});

// ── GET /v1/tools — list all tools across all apps (for MCP server) ──
toolsRoutes.get('/tools', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT app_id, name, manifest FROM app_tools ORDER BY app_id, name',
  ).all<{ app_id: string; name: string; manifest: string }>();

  const tools: unknown[] = [];
  for (const r of result.results ?? []) {
    try {
      tools.push({ app_id: r.app_id, name: r.name, ...JSON.parse(r.manifest) });
    } catch { /* skip corrupted row */ }
  }

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
