/**
 * App tool CRUD — apps register MCP tools via `pas publish` (reads mcp.json).
 * The MCP server fetches tools from GET /v1/tools to register them dynamically.
 */

import { Hono } from 'hono';
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
}

function validateManifest(tool: ToolManifest): string | null {
  if (!tool.name || typeof tool.name !== 'string') return 'name is required';
  if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) return 'name must be lowercase alphanumeric with underscores';
  if (!tool.description || typeof tool.description !== 'string') return 'description is required';
  if (!['query', 'execute'].includes(tool.operation)) return 'operation must be "query" or "execute"';
  if (!tool.sql || typeof tool.sql !== 'string') return 'sql is required';

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

  // Auto-enforce: if SQL uses __user_id, requires_auth must be true
  if (sqlParams.includes('__user_id') && !tool.requires_auth) {
    return 'SQL uses :__user_id but requires_auth is not set to true';
  }

  return null;
}

// ── PUT /v1/apps/:appId/tools — bulk register tools from mcp.json ──
toolsRoutes.put('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);

  const body = await c.req.json<{ tools?: ToolManifest[] }>().catch(() => null);
  if (!body?.tools || !Array.isArray(body.tools)) {
    return c.json({ error: 'tools array required' }, 400);
  }

  if (body.tools.length > 50) {
    return c.json({ error: 'max 50 tools per app' }, 400);
  }

  // Validate all tools first
  for (const tool of body.tools) {
    const err = validateManifest(tool);
    if (err) return c.json({ error: `tool "${tool.name}": ${err}` }, 400);
  }

  const now = Date.now();

  // Delete existing tools for this app, then insert new ones
  const stmts = [
    c.env.DB.prepare('DELETE FROM app_tools WHERE app_id = ?').bind(appId),
    ...body.tools.map(tool =>
      c.env.DB.prepare(
        'INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(appId, tool.name, JSON.stringify(tool), now, now),
    ),
  ];

  await c.env.DB.batch(stmts);
  return c.json({ ok: true, registered: body.tools.length });
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
