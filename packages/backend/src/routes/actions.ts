import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireUser, type FasUser } from '../lib/auth.js';
import { prepareActionBatch, prepareActionQuery, type ToolManifest } from '../lib/action-sql.js';

export const actionRoutes = new Hono<{ Bindings: Env }>();

interface ActionBody {
  params?: Record<string, unknown>;
}

actionRoutes.post('/apps/:appId/actions/:name', async (c) => {
  const appId = c.req.param('appId')!;
  const name = c.req.param('name')!;
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    throw new HttpError('invalid app id', 400);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new HttpError('invalid action name', 400);
  }

  const manifest = await loadManifest(c.env.DB, appId, name);
  const publicAction = manifest.requires_auth === false;
  let token: string | null = null;
  let userId = '';

  if (publicAction) {
    const stalePublicError = validatePublicManifestForExecution(manifest);
    if (stalePublicError) throw new HttpError(`public action manifest is invalid: ${stalePublicError}`, 500);
  } else {
    token = bearerToken(c.req.header('Authorization'));
    if (!token) throw new HttpError('missing bearer token', 401);
    const user = await requireUser(c);
    userId = user.id;
    await enforceActionAuth(c.env.DB, appId, manifest, user);
  }

  const body = await c.req.json<ActionBody>().catch(() => {
    throw new HttpError('invalid JSON body', 400);
  });
  const input =
    body.params === undefined
      ? {}
      : body.params !== null && typeof body.params === 'object' && !Array.isArray(body.params)
        ? body.params
        : null;
  if (!input) throw new HttpError('params must be an object', 400);
  let endpoint: string;
  let payload: unknown;
  try {
    if (manifest.operation === 'batch') {
      // Batch tools run all statements in ONE D1 transaction on the data
      // worker — multi-step flows can't be left half-applied.
      endpoint = 'batch';
      payload = { statements: prepareActionBatch(manifest, input, userId) };
    } else {
      endpoint = manifest.operation === 'query' ? 'query' : 'execute';
      payload = prepareActionQuery(manifest, input, userId);
    }
  } catch (e) {
    throw new HttpError(e instanceof Error ? e.message : String(e), 400);
  }
  // Forward with the platform internal token so the data-worker trusts this as
  // prepared, role-checked SQL (identity already injected via __user_id) and
  // runs it for the end-user without requiring them to own the app. Public
  // read-only actions deliberately omit Authorization; authenticated actions
  // still forward it for compatibility with un-redeployed data workers.
  const upstream = await fetch(`https://data-${appId}.proappstore.online/${endpoint}`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(c.env.INTERNAL_TOKEN ? { 'X-Internal-Token': c.env.INTERNAL_TOKEN } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
    },
  });
});

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function validatePublicManifestForExecution(manifest: ToolManifest): string | null {
  if (manifest.operation !== 'query') return 'operation must be query';
  const sql = manifest.sql ?? '';
  if (/:__user_id\b/.test(sql)) return 'must not reference :__user_id';
  if ((manifest.auth?.platform_roles?.length ?? 0) > 0 || (manifest.auth?.app_roles?.length ?? 0) > 0) {
    return 'must not declare auth roles';
  }
  if (manifest.auth?.required === true) return 'must not require auth';
  const withoutComments = sql
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const match = /\bLIMIT\s+(\d+)\b/i.exec(withoutComments);
  if (!match) return 'must include a literal LIMIT';
  if (withoutComments.slice(match.index + match[0].length).trim().startsWith(',')) {
    return 'must not use comma LIMIT syntax';
  }
  if (Number(match[1]) > 500) return 'LIMIT must be 500 or less';
  return null;
}

async function loadManifest(db: D1Database, appId: string, name: string): Promise<ToolManifest> {
  const row = await db.prepare('SELECT manifest FROM app_tools WHERE app_id = ? AND name = ?')
    .bind(appId, name)
    .first<{ manifest: string }>();
  if (!row) throw new HttpError('action not found', 404);

  try {
    return JSON.parse(row.manifest) as ToolManifest;
  } catch {
    throw new HttpError('action manifest is invalid', 500);
  }
}

async function enforceActionAuth(
  db: D1Database,
  appId: string,
  manifest: ToolManifest,
  user: FasUser,
): Promise<void> {
  const platformRoles = manifest.auth?.platform_roles ?? [];
  if (platformRoles.length > 0 && !platformRoles.some((role) => user.roles.includes(role))) {
    throw new HttpError('requires platform role', 403);
  }

  const appRoles = manifest.auth?.app_roles ?? [];
  if (appRoles.length === 0) return;

  const tokenRoles = new Set(user.appRoles?.[appId] ?? []);
  if (appRoles.some((role) => tokenRoles.has(role))) {
    return;
  }

  const rows = await db.prepare('SELECT role_name FROM app_roles WHERE app_id = ? AND (user_id = ? OR user_id = ?)')
    .bind(appId, user.id, user.login)
    .all<{ role_name: string }>();
  const assigned = new Set((rows.results ?? []).map((row) => row.role_name));
  if (!appRoles.some((role) => assigned.has(role))) {
    throw new HttpError('requires app role', 403);
  }
}
