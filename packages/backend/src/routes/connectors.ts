/**
 * The GitHub connector (#258): a platform-owned GitHub App that apps bind to by
 * installation. The app's manifest declares `connectors` (routes/tools.ts); this
 * file is the owner's connect flow and the single webhook endpoint GitHub allows.
 *
 *   GET    /v1/apps/:appId/connectors                                   owner  — declared connectors + bound installations
 *   GET    /v1/apps/:appId/connectors/github/install                    owner  — to github.com/apps/<slug>/installations/new (JSON {url} with Accept: application/json — a browser fetch cannot follow a cross-origin 302)
 *   GET    /v1/connectors/github/setup                                  GitHub's callback (no session on a top-level redirect: with no Bearer it hands the parameters to the console)
 *   POST   /v1/connectors/github/setup                                  the console completing the above, signed in
 *   DELETE /v1/apps/:appId/connectors/github/installations/:id          owner  — unbind
 *   POST   /v1/connectors/github/webhook                                public — GitHub; verified with the platform GH_APP_WEBHOOK_SECRET
 *
 * Binding is the security-critical step: lib/github-app.ts `proveInstallationControl`.
 * The webhook demuxes by `installation.id` into the #256 pipeline of every bound app
 * whose manifest subscribes to the event. Every route answers 503 until the App's
 * [vars] and secrets are all present.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError, optionalUser, requireAppOwner, requireUser } from '../lib/auth.js';
import { connectorConfigured, getInstallation, proveInstallationControl, signConnectorState, verifyConnectorState } from '../lib/github-app.js';
import { verifyHookDelivery } from '../lib/hook-verifiers.js';
import { ingestVerifiedDelivery, MAX_HOOK_BODY_BYTES } from './hooks.js';

export const connectorRoutes = new Hono<{ Bindings: Env }>();

const CONSOLE = 'https://console.proappstore.online';
const NOT_CONFIGURED = 'connector not configured';

interface ConnectorRow { name: string; modes: string; pat_secret: string | null; events: string; hook: string | null }

const unavailable = (c: Context<{ Bindings: Env }>) => c.json({ error: NOT_CONFIGURED }, 503);

async function githubConnector(db: D1Database, appId: string): Promise<ConnectorRow | null> {
  return db.prepare("SELECT name, modes, pat_secret, events, hook FROM app_connectors WHERE app_id = ? AND kind = 'github'").bind(appId).first<ConnectorRow>();
}

connectorRoutes.get('/apps/:appId/connectors', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  const connectors = await c.env.DB.prepare('SELECT name, kind, modes, pat_secret, events, hook FROM app_connectors WHERE app_id = ? ORDER BY name').bind(appId)
    .all<{ name: string; kind: string; modes: string; pat_secret: string | null; events: string; hook: string | null }>();
  const installations = await c.env.DB.prepare(
    'SELECT connector, installation_id, account_login, account_type, created_at FROM app_connector_installations WHERE app_id = ? ORDER BY created_at',
  ).bind(appId).all();
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    configured: connectorConfigured(c.env),
    connectors: (connectors.results ?? []).map((r) => ({ ...r, modes: JSON.parse(r.modes) as string[], events: JSON.parse(r.events) as string[] })),
    installations: installations.results ?? [],
  });
});

connectorRoutes.get('/apps/:appId/connectors/github/install', async (c) => {
  const appId = c.req.param('appId');
  const user = await requireAppOwner(c, appId);
  if (!connectorConfigured(c.env)) return unavailable(c);
  if (!(await githubConnector(c.env.DB, appId))) return c.json({ error: 'this app declares no github connector' }, 404);
  const state = await signConnectorState(c.env, appId, user.id);
  const url = `https://github.com/apps/${encodeURIComponent(c.env.GH_APP_SLUG!)}/installations/new?state=${encodeURIComponent(state)}`;
  c.header('Cache-Control', 'private, no-store');
  return (c.req.header('Accept') ?? '').includes('application/json') ? c.json({ url }) : c.redirect(url, 302);
});

interface SetupParams { installation_id?: unknown; setup_action?: unknown; state?: unknown; code?: unknown }

/** The proof and the upsert. Every refusal is a 403 and writes nothing. */
async function completeSetup(c: Context<{ Bindings: Env }>, p: SetupParams): Promise<{ appId: string; installationId: number; account: string }> {
  const raw = typeof p.state === 'string' ? p.state : '';
  const state = await verifyConnectorState(c.env, raw);
  if (!state) throw new HttpError('invalid or expired state; start the connection again', 403);
  // The state names who started the flow; only that user, still the app's owner, may finish it.
  const user = await requireAppOwner(c, state.appId);
  if (state.userId !== user.id) throw new HttpError('this connection was started by a different user', 403);
  const installationId = Number(p.installation_id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new HttpError('installation_id is required', 400);
  if (!(await githubConnector(c.env.DB, state.appId))) throw new HttpError('this app declares no github connector', 404);

  const installation = await getInstallation(c.env, installationId).catch(() => null);
  if (!installation) throw new HttpError('installation not found', 404);
  const proof = await proveInstallationControl(c.env, user, installation, typeof p.code === 'string' && p.code ? p.code : null);
  if (!proof.ok) throw new HttpError(proof.error, 403);

  await c.env.DB.prepare(
    `INSERT INTO app_connector_installations (app_id, connector, installation_id, account_login, account_type, created_by, created_at)
     VALUES (?, 'github', ?, ?, ?, ?, ?)
     ON CONFLICT (app_id, connector, installation_id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type`,
  ).bind(state.appId, installation.id, installation.account.login, installation.account.type, user.id, Date.now()).run();
  return { appId: state.appId, installationId: installation.id, account: installation.account.login };
}

connectorRoutes.get('/connectors/github/setup', async (c) => {
  if (!connectorConfigured(c.env)) return unavailable(c);
  const q = c.req.query();
  // GitHub's redirect is a plain navigation: no Authorization header. Without a session the
  // parameters (and the single-use code) go to the console, which POSTs them back signed in.
  if (!(await optionalUser(c))) {
    return c.redirect(`${CONSOLE}/#/connectors/github/setup?${new URLSearchParams({ installation_id: q.installation_id ?? '', setup_action: q.setup_action ?? '', state: q.state ?? '', ...(q.code ? { code: q.code } : {}) })}`, 302);
  }
  const done = await completeSetup(c, q);
  return c.redirect(`${CONSOLE}/#/apps/${encodeURIComponent(done.appId)}?connector=github&installed=${encodeURIComponent(done.account)}`, 302);
});

connectorRoutes.post('/connectors/github/setup', async (c) => {
  if (!connectorConfigured(c.env)) return unavailable(c);
  await requireUser(c);
  const body = await c.req.json<SetupParams>().catch(() => null);
  if (!body || typeof body !== 'object') throw new HttpError('JSON body required', 400);
  const done = await completeSetup(c, body);
  return c.json({ ok: true, installation_id: done.installationId, account: done.account });
});

connectorRoutes.delete('/apps/:appId/connectors/github/installations/:id', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError('invalid installation id', 400);
  const res = await c.env.DB.prepare("DELETE FROM app_connector_installations WHERE app_id = ? AND connector = 'github' AND installation_id = ?").bind(appId, id).run();
  if (!res.meta.changes) throw new HttpError('installation not bound to this app', 404);
  return c.json({ ok: true });
});

// ── Webhook demux ────────────────────────────────────────────────────────────

interface GithubEventBody { action?: string; installation?: { id?: number }; account?: { login?: string } }

/** `installation` / `installation_repositories` / `installation_target` keep our bindings true. */
async function applyInstallationEvent(db: D1Database, event: string, body: GithubEventBody, installationId: number): Promise<void> {
  if (event === 'installation' && body.action === 'deleted') {
    await db.batch([
      db.prepare('DELETE FROM app_connector_installations WHERE installation_id = ?').bind(installationId),
      db.prepare('DELETE FROM github_installation_tokens WHERE installation_id = ?').bind(installationId),
    ]);
  } else if (event === 'installation_target' && body.account?.login) {
    await db.prepare('UPDATE app_connector_installations SET account_login = ? WHERE installation_id = ?').bind(body.account.login, installationId).run();
  }
}

connectorRoutes.post('/connectors/github/webhook', async (c) => {
  if (!connectorConfigured(c.env)) return unavailable(c);
  if (Number(c.req.header('content-length') ?? 0) > MAX_HOOK_BODY_BYTES) return c.json({ error: `body exceeds ${MAX_HOOK_BODY_BYTES} bytes` }, 413);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_HOOK_BODY_BYTES) return c.json({ error: `body exceeds ${MAX_HOOK_BODY_BYTES} bytes` }, 413);
  const verified = await verifyHookDelivery({ kind: 'github-hmac-sha256' }, c.env.GH_APP_WEBHOOK_SECRET!, body, c.req.raw.headers);
  if (!verified) return c.json({ error: 'signature verification failed' }, 401);

  let payload: GithubEventBody;
  try { payload = JSON.parse(new TextDecoder().decode(body)) as GithubEventBody; } catch { return c.json({ accepted: true, delivered: 0 }, 202); }
  const installationId = payload.installation?.id;
  // ping, and anything not tied to an installation: nothing to route.
  if (typeof installationId !== 'number') return c.json({ accepted: true, delivered: 0 }, 202);
  const event = verified.event ?? '';

  const bound = await c.env.DB.prepare(
    `SELECT i.app_id, k.events, k.hook, h.target
       FROM app_connector_installations i
       JOIN app_connectors k ON k.app_id = i.app_id AND k.name = i.connector
       JOIN app_hooks h ON h.app_id = k.app_id AND h.name = k.hook AND h.verify_kind = 'github-app'
      WHERE i.installation_id = ? AND i.connector = 'github'`,
  ).bind(installationId).all<{ app_id: string; events: string; hook: string; target: string }>();

  await applyInstallationEvent(c.env.DB, event, payload, installationId);

  let delivered = 0;
  for (const row of bound.results ?? []) {
    if (!(JSON.parse(row.events) as string[]).includes(event)) continue;
    // De-dupe by X-GitHub-Delivery per app is the #256 pipeline's own (app, hook, delivery id) key.
    await ingestVerifiedDelivery(c, row.app_id, row.hook, row.target, verified, body);
    delivered++;
  }
  return c.json({ accepted: true, delivered }, 202);
});
