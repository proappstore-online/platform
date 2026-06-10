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
  operation: 'query' | 'execute';
  sql: string;
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
  if (!['query', 'execute'].includes(tool.operation)) return 'operation must be "query" or "execute"';
  if (!tool.sql || typeof tool.sql !== 'string') return 'sql is required';
  if (tool.requires_auth !== true) return 'requires_auth must be true for app data tools';

  const sqlErr = validateSql(tool.sql, tool.operation);
  if (sqlErr) return sqlErr;

  // params must be an object (default to empty)
  if (tool.params !== undefined && tool.params !== null && typeof tool.params !== 'object') {
    return 'params must be an object';
  }
  const params = tool.params || {};

  // All :paramName in SQL must be declared in params (except magic params)
  const magicParams = new Set(['__user_id', '__now', '__uuid']);
  const sqlParams = [...tool.sql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(m => m[1]!!);
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
 * Validate a tools[] manifest and replace the app's registered tools (atomic
 * DELETE + INSERT). Shared by the owner-auth PUT (CLI `pas publish`) and the
 * internal POST (Agent Teams deploy stage). Returns a status + payload the
 * caller hands straight back as JSON.
 */
async function replaceAppTools(
  db: D1Database,
  appId: string,
  tools: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!tools || !Array.isArray(tools)) {
    return { status: 400, payload: { error: 'tools array required' } };
  }
  if (tools.length > 50) {
    return { status: 400, payload: { error: 'max 50 tools per app' } };
  }
  for (const tool of tools as ToolManifest[]) {
    const err = validateManifest(tool);
    if (err) return { status: 400, payload: { error: `tool "${tool?.name}": ${err}` } };
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
  return { status: 200, payload: { ok: true, registered: tools.length } };
}

// ── PUT /v1/apps/:appId/tools — bulk register tools from mcp.json ──
toolsRoutes.put('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);

  const body = await c.req.json<{ tools?: ToolManifest[] }>().catch(() => null);
  const { status, payload } = await replaceAppTools(c.env.DB, appId, body?.tools);
  return c.json(payload, status as 200 | 400);
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
  const { status, payload } = await replaceAppTools(c.env.DB, appId, body?.tools ?? []);
  return c.json(payload, status as 200 | 400);
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
