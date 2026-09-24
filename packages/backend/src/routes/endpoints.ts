/**
 * Console-defined API endpoints (#155): read / insert actions built from a
 * structured config, stored in app_tools under source = 'console' so a deploy
 * never wipes them. The console UI (proappstore-online/console#3) consumes
 * exactly these four routes; keep the response shapes and the 400 / 409 / 422 /
 * 503 mapping stable.
 *
 * Owner sessions only. requireAppOwner → requireUser → verifySession accepts a
 * session JWT alone, so a personal app token (#154) can never manage endpoints.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireAppOwner } from '../lib/auth.js';
import { dataWorkerUrl } from '../lib/data-worker-url.js';
import {
  CONSOLE_ENDPOINT_CAP,
  ENDPOINT_NAME_RE,
  generateEndpointManifest,
  validateEndpointConfig,
  type ColumnInfo,
  type EndpointConfig,
} from '../lib/endpoint-sql.js';
import { checkSchemaCoherence, validateToolSet, type ToolManifest } from './tools.js';

export const endpointsRoutes = new Hono<{ Bindings: Env }>();

interface EndpointRow { name: string; manifest: string; config: string | null; updated_at: number; updated_by: string | null; source: string }

/**
 * The live schema of one table, straight from the app's data worker (internal
 * path, #153). Throws 503 when it cannot be read: without the schema the
 * generator cannot type a single param, so there is nothing safe to save —
 * stricter on purpose than the deploy-time coherence check, which skips.
 */
async function readTableSchema(env: Env, appId: string, table: string): Promise<ColumnInfo[]> {
  let res: Response;
  try {
    res = await fetch(dataWorkerUrl(env, appId, '/query'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.INTERNAL_TOKEN ? { 'X-Internal-Token': env.INTERNAL_TOKEN } : {}),
      },
      // `table` already matched the identifier rule in validateEndpointConfig.
      body: JSON.stringify({ sql: `PRAGMA table_info("${table}")` }),
    });
  } catch {
    throw new SchemaUnavailable();
  }
  if (!res.ok) throw new SchemaUnavailable();
  const data = (await res.json().catch(() => null)) as { rows?: ColumnInfo[] } | null;
  if (!data || !Array.isArray(data.rows)) throw new SchemaUnavailable();
  return data.rows;
}

class SchemaUnavailable extends Error {}

type Built =
  | { ok: true; config: EndpointConfig; manifest: ToolManifest }
  | { ok: false; status: 400 | 422 | 503; payload: Record<string, unknown> };

/** Config → validated manifest, or the exact status the console maps. */
async function build(env: Env, appId: string, raw: unknown): Promise<Built> {
  const shape = validateEndpointConfig(raw);
  if (shape.length) return { ok: false, status: 400, payload: { error: 'invalid endpoint config', details: shape } };
  const config = raw as EndpointConfig;
  let columns: ColumnInfo[];
  try {
    columns = await readTableSchema(env, appId, config.table);
  } catch {
    return { ok: false, status: 503, payload: { error: 'could not read the app schema from its data worker; try again' } };
  }
  const gen = generateEndpointManifest(config, columns);
  if (!gen.ok) return { ok: false, status: 400, payload: { error: gen.error, details: gen.details } };
  const invalid = await validateToolSet([gen.manifest], env, appId, { source: 'console' });
  if (invalid) return { ok: false, status: invalid.status === 422 ? 422 : 400, payload: invalid.payload };
  return { ok: true, config, manifest: gen.manifest };
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

// ── GET /v1/apps/:appId/endpoints ─────────────────────────────────
// `status` re-runs schema coherence for the console rows, so a column dropped
// by a later code migration shows as `broken` here instead of `no such column`
// at call time.
endpointsRoutes.get('/apps/:appId/endpoints', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const result = await c.env.DB.prepare(
    "SELECT name, manifest, config, updated_at, updated_by, source FROM app_tools WHERE app_id = ? AND source = 'console' ORDER BY name",
  ).bind(appId).all<EndpointRow>();
  const rows = (result.results ?? []).map((r) => ({ row: r, manifest: parseJson<ToolManifest>(r.manifest) }));
  const errors = await checkSchemaCoherence(c.env, appId, rows.map((x) => x.manifest).filter((m): m is ToolManifest => !!m));
  const endpoints = rows.map(({ row, manifest }) => {
    const error = manifest ? errors.find((e) => e.startsWith(`tool "${manifest.name}"`)) : 'stored manifest is not valid JSON';
    return {
      name: row.name,
      config: parseJson(row.config),
      manifest,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
      status: error ? 'broken' : 'ok',
      ...(error ? { error: error.replace(/^tool "[^"]*": /, '') } : {}),
    };
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ endpoints });
});

// ── POST /v1/apps/:appId/endpoints/preview ────────────────────────
endpointsRoutes.post('/apps/:appId/endpoints/preview', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const body = await c.req.json<{ config?: unknown }>().catch(() => null);
  const built = await build(c.env, appId, body?.config);
  if (!built.ok) return c.json(built.payload, built.status);
  return c.json({ manifest: built.manifest });
});

// ── PUT /v1/apps/:appId/endpoints/:name ───────────────────────────
endpointsRoutes.put('/apps/:appId/endpoints/:name', async (c) => {
  const appId = c.req.param('appId')!;
  const name = c.req.param('name')!;
  const user = await requireAppOwner(c, appId);
  if (!ENDPOINT_NAME_RE.test(name)) {
    return c.json({ error: `endpoint names must match ${ENDPOINT_NAME_RE} (the api_ prefix is required)` }, 400);
  }
  const body = await c.req.json<{ config?: unknown }>().catch(() => null);
  const raw = body?.config;
  if (raw && typeof raw === 'object' && (raw as { name?: unknown }).name !== name) {
    return c.json({ error: 'config.name must equal the endpoint name in the URL' }, 400);
  }
  const built = await build(c.env, appId, raw);
  if (!built.ok) return c.json(built.payload, built.status);

  const existing = await c.env.DB.prepare('SELECT source FROM app_tools WHERE app_id = ? AND name = ?')
    .bind(appId, name).first<{ source: string | null }>();
  if (existing && existing.source !== 'console') {
    return c.json({ error: `"${name}" is already registered by the app's code (mcp.json)` }, 409);
  }
  if (!existing) {
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM app_tools WHERE app_id = ? AND source = 'console'")
      .bind(appId).first<{ n: number }>();
    if ((count?.n ?? 0) >= CONSOLE_ENDPOINT_CAP) {
      return c.json({ error: `max ${CONSOLE_ENDPOINT_CAP} console endpoints per app` }, 400);
    }
  }

  const now = Date.now();
  const manifestJson = JSON.stringify(built.manifest);
  const configJson = JSON.stringify(built.config);
  const action = existing ? 'update' : 'create';
  // The row and its audit entry land together or not at all.
  await c.env.DB.batch([
    existing
      ? c.env.DB.prepare("UPDATE app_tools SET manifest = ?, config = ?, updated_at = ?, updated_by = ? WHERE app_id = ? AND name = ? AND source = 'console'")
          .bind(manifestJson, configJson, now, user.id, appId, name)
      : c.env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source, config, updated_by) VALUES (?, ?, ?, ?, ?, 'console', ?, ?)")
          .bind(appId, name, manifestJson, now, now, configJson, user.id),
    c.env.DB.prepare('INSERT INTO app_endpoint_audit (app_id, name, action, user_id, config, at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(appId, name, action, user.id, configJson, now),
  ]);
  return c.json({ endpoint: { name, config: built.config, manifest: built.manifest, updated_at: now, updated_by: user.id, status: 'ok' } });
});

// ── DELETE /v1/apps/:appId/endpoints/:name ────────────────────────
endpointsRoutes.delete('/apps/:appId/endpoints/:name', async (c) => {
  const appId = c.req.param('appId')!;
  const name = c.req.param('name')!;
  const user = await requireAppOwner(c, appId);
  const existing = await c.env.DB.prepare("SELECT 1 AS present FROM app_tools WHERE app_id = ? AND name = ? AND source = 'console'")
    .bind(appId, name).first<{ present: number }>();
  if (!existing) return c.json({ error: 'endpoint not found' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM app_tools WHERE app_id = ? AND name = ? AND source = 'console'").bind(appId, name),
    c.env.DB.prepare('INSERT INTO app_endpoint_audit (app_id, name, action, user_id, config, at) VALUES (?, ?, ?, ?, NULL, ?)')
      .bind(appId, name, 'delete', user.id, Date.now()),
  ]);
  return c.json({ ok: true });
});
