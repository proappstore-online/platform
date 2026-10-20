/**
 * An app's own MCP endpoint and the signed-in account's OAuth grants on it (#457),
 * for the Creator Console (proappstore-online/console#4).
 *
 * The grants live in the MCP worker's KV, so these routes are thin: they resolve
 * the caller from their session, check the app exists, and ask the MCP worker over
 * the authenticated service binding. The uid always comes from the session, never
 * from the URL, so an account sees and revokes only its own grants. A grant record
 * holds no token, no session and no other account's details.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireUser } from '../lib/auth.js';

export const mcpGrantRoutes = new Hono<{ Bindings: Env }>();

const APP_ID_RE = /^[a-z][a-z0-9-]{0,57}$/;
const GRANT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const DEFAULT_MCP_ORIGIN = 'https://mcp.proappstore.online';

async function mcp(env: Env, path: string, method: 'GET' | 'DELETE'): Promise<Response> {
  if (!env.MCP || !env.INTERNAL_TOKEN) throw new HttpError('MCP service is not configured', 503);
  try {
    return await env.MCP.fetch(`https://mcp${path}`, { method, headers: { 'X-Internal-Token': env.INTERNAL_TOKEN } });
  } catch {
    throw new HttpError('MCP service is unreachable — retry later', 503);
  }
}

async function requireApp(env: Env, appId: string): Promise<void> {
  if (!APP_ID_RE.test(appId)) throw new HttpError('app not found', 404);
  const app = await env.DB.prepare('SELECT id FROM apps WHERE id = ?').bind(appId).first<{ id: string }>();
  if (!app) throw new HttpError('app not found', 404);
}

mcpGrantRoutes.get('/apps/:appId/mcp', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId');
  await requireApp(c.env, appId);
  const res = await mcp(c.env, `/internal/users/${encodeURIComponent(user.id)}/apps/${appId}/grants`, 'GET');
  if (!res.ok) throw new HttpError('could not read MCP grants', 502);
  const data = await res.json().catch(() => null) as { grants?: unknown } | null;
  const grants = Array.isArray(data?.grants) ? data.grants : [];
  return c.json({
    app_id: appId,
    endpoint_url: `${(c.env.MCP_ORIGIN ?? DEFAULT_MCP_ORIGIN).replace(/\/$/, '')}/mcp/apps/${appId}`,
    grants: grants.map((g) => {
      const grant = g as Record<string, unknown>;
      return {
        id: String(grant.id),
        client_name: typeof grant.client_name === 'string' ? grant.client_name : null,
        scope: 'app',
        created_at: Number(grant.created_at) || 0,
        last_used_at: Number(grant.last_used_at) || 0,
      };
    }),
  }, 200, { 'Cache-Control': 'no-store' });
});

mcpGrantRoutes.delete('/apps/:appId/mcp/grants/:grantId', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId');
  const grantId = c.req.param('grantId');
  await requireApp(c.env, appId);
  if (!GRANT_ID_RE.test(grantId)) throw new HttpError('grant not found', 404);
  // The grant must be one of this account's grants on THIS app's endpoint.
  const list = await mcp(c.env, `/internal/users/${encodeURIComponent(user.id)}/apps/${appId}/grants`, 'GET');
  if (!list.ok) throw new HttpError('could not read MCP grants', 502);
  const listed = await list.json().catch(() => null) as { grants?: Array<{ id?: unknown }> } | null;
  if (!listed?.grants?.some((g) => g.id === grantId)) throw new HttpError('grant not found', 404);
  const res = await mcp(c.env, `/internal/users/${encodeURIComponent(user.id)}/grants/${grantId}`, 'DELETE');
  if (res.status === 404) throw new HttpError('grant not found', 404);
  if (!res.ok) throw new HttpError('could not revoke the grant', 502);
  return c.json({ revoked: true, id: grantId }, 200, { 'Cache-Control': 'no-store' });
});
