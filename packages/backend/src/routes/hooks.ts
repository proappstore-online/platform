/**
 * Inbound webhooks (#256, ADR-009 §3–§4).
 *
 *   POST /v1/apps/:appId/hooks/:name       public — a third party (GitHub, Stripe, …) tells the app something happened
 *   GET  /v1/apps/:appId/hooks             owner  — registered hooks: URL, verifier, whether the secret is set (#261)
 *   GET  /v1/apps/:appId/hook-deliveries   owner  — recent deliveries; never the body
 *
 * The POST fails closed at every step, in this order: body ≤ 5 MB (413); the
 * hook exists (404, with no hint whether the app does); the raw bytes, read once,
 * verify against the hook's verifier (401 — no row is written, no app code runs);
 * the delivery id is de-duplicated (a repeat of a received/delivered delivery is
 * 200 {duplicate:true}; a repeat of a failed one is a redelivery). Then the
 * app's daily hook quota (#275): over it, the row is `quota_exceeded` and nothing
 * is delivered — still a 202, because GitHub never redelivers on its own and a
 * 429 would lose the event just the same; the owner redelivers it from the sender
 * after the reset. Then 202, and delivery continues in waitUntil with a 25 s
 * budget (Cloudflare cancels waitUntil 30 s after the response; #257 moves
 * delivery to a queue). A worker over its invocation quota ends `quota_exceeded`
 * the same way.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import { openAppSecret } from '../lib/app-secrets.js';
import { activeAppWorker, appWorkerHost, type AppWorkerExports } from '../lib/app-worker-host.js';
import { actionCallers, prepareActionBatch, prepareActionQuery, type ToolManifest } from '../lib/action-sql.js';
import { encodeEnvelopeBody, hookHeaders, verifyHookDelivery, type HookVerify } from '../lib/hook-verifiers.js';
import { AppWorkerQuotaError, quotasFrom, reserveHookDelivery } from '../lib/app-worker-usage.js';
import { forwardToDataWorker, loadManifest } from './actions.js';
import type { HookTarget } from './tools.js';

export const MAX_HOOK_BODY_BYTES = 5 * 1024 * 1024;
/** ADR-009 §4 hook budget: 25 s of the 30 s waitUntil, until #257's queue. */
export const HOOK_TIMEOUT_MS = 25_000;
export const SYSTEM_HOOK_USER = 'system:hook';

export const hookRoutes = new Hono<{ Bindings: Env }>();

interface HookRow { name: string; verify_kind: string; secret_name: string | null; verify_opts: string | null; target: string }
interface DeliveryRow { id: string; status: string; attempts: number }

export interface HookDelivery {
  appId: string;
  hook: string;
  target: HookTarget;
  /** app_hook_deliveries.id — the envelope id, stable across redeliveries. */
  rowId: string;
  attempt: number;
  body: Uint8Array;
  headers: Headers;
}

/** `$`, `$.a.b`, `$.a[0]` into a parsed JSON body; undefined where the path does not lead. */
export function resolveHookPath(body: unknown, path: string): unknown {
  let value: unknown = body;
  for (const [, key, index] of path.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
    if (value === null || typeof value !== 'object') return undefined;
    value = key !== undefined ? (value as Record<string, unknown>)[key] : (value as unknown[])[Number(index)];
  }
  return value;
}

/** The action's params: paths read from the JSON body, everything else literal. */
export function mapHookParams(params: Record<string, unknown>, body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && v.startsWith('$')) {
      const resolved = resolveHookPath(body, v);
      if (resolved !== undefined) out[k] = resolved;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Deliver a verified, de-duplicated delivery. Returns null on success, else the error to record. */
export async function deliverHook(env: Env, d: HookDelivery, ctx?: AppWorkerExports): Promise<string | null> {
  if (d.target === 'worker') {
    if (!(await activeAppWorker(env, d.appId))) return 'app worker not deployed';
    const result = await appWorkerHost(env, ctx).invoke(d.appId, {
      id: d.rowId, type: 'hook', name: d.hook, attempt: d.attempt,
      payload: { headers: hookHeaders(d.headers), ...encodeEnvelopeBody(d.body, d.headers.get('content-type')) },
    }, { timeoutMs: HOOK_TIMEOUT_MS });
    if (result.status === 'succeeded') return null;
    return result.status === 'timeout' ? `worker timed out after ${HOOK_TIMEOUT_MS} ms` : `worker answered ${result.httpStatus ?? 'no response'}`;
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(d.body));
  } catch {
    return 'the body is not JSON, so its params cannot be mapped';
  }
  // Re-checked at delivery: the manifest may have changed since registration.
  const manifest: ToolManifest = await loadManifest(env.DB, d.appId, d.target.action);
  if (!actionCallers(manifest).includes('hook') || manifest.schedule !== undefined || manifest.auth?.app_roles?.length || manifest.auth?.platform_roles?.length) {
    return `action "${d.target.action}" is not a hook action`;
  }
  const input = mapHookParams(d.target.params, json);
  const endpoint = manifest.operation === 'batch' ? 'batch' : 'execute';
  const payload = endpoint === 'batch' ? { statements: prepareActionBatch(manifest, input, SYSTEM_HOOK_USER) } : prepareActionQuery(manifest, input, SYSTEM_HOOK_USER);
  const res = await forwardToDataWorker(env, d.appId, endpoint, payload, null);
  if (res.ok) return null;
  return `action ${d.target.action} failed (${res.status}): ${(await res.text()).slice(0, 300)}`;
}

async function finish(env: Env, rowId: string, error: string | null, status: 'failed' | 'quota_exceeded' = 'failed'): Promise<void> {
  await env.DB.prepare('UPDATE app_hook_deliveries SET status = ?, finished_at = ?, error = ? WHERE id = ?')
    .bind(error === null ? 'delivered' : status, Date.now(), error === null ? null : error.slice(0, 500), rowId).run();
}

/** A delivery that will not be processed: over quota, or the quota check could not run (#275). */
function notProcessed(e: unknown): { error: string; status: 'failed' | 'quota_exceeded' } {
  return e instanceof AppWorkerQuotaError
    ? { error: `quota exceeded (${e.quota}); redeliver it from the sender after 00:00 UTC`, status: 'quota_exceeded' }
    : { error: String((e as Error)?.message ?? e), status: 'failed' };
}

function runAfterResponse(c: Context<{ Bindings: Env }>, work: Promise<void>): void {
  try { c.executionCtx.waitUntil(work); } catch { void work; }
}

hookRoutes.post('/apps/:appId/hooks/:name', async (c) => {
  const appId = c.req.param('appId');
  const name = c.req.param('name');
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_HOOK_BODY_BYTES) return c.json({ error: `body exceeds ${MAX_HOOK_BODY_BYTES} bytes` }, 413);

  const hook = await c.env.DB.prepare(
    'SELECT h.name, h.verify_kind, h.secret_name, h.verify_opts, h.target FROM app_hooks h INNER JOIN apps a ON a.id = h.app_id WHERE h.app_id = ? AND h.name = ?',
  ).bind(appId, name).first<HookRow>();
  // github-app hooks are fed only by the platform's GitHub App demux (#258).
  if (!hook || hook.verify_kind === 'github-app') return c.json({ error: 'not found' }, 404);

  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_HOOK_BODY_BYTES) return c.json({ error: `body exceeds ${MAX_HOOK_BODY_BYTES} bytes` }, 413);

  const verify: HookVerify = { kind: hook.verify_kind as HookVerify['kind'], ...(hook.verify_opts ? JSON.parse(hook.verify_opts) as object : {}) };
  const secret = c.env.APP_SECRET_KEK && hook.secret_name ? await openAppSecret(c.env, c.env.APP_SECRET_KEK, appId, hook.secret_name) : null;
  const verified = secret ? await verifyHookDelivery(verify, secret, body, c.req.raw.headers) : null;
  if (!verified) return c.json({ error: 'signature verification failed' }, 401);

  const now = Date.now();
  const rowId = crypto.randomUUID();
  const inserted = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO app_hook_deliveries (id, app_id, hook, delivery_id, event, received_at, status, attempts)
     VALUES (?, ?, ?, ?, ?, ?, 'received', 1)`,
  ).bind(rowId, appId, name, verified.deliveryId, verified.event, now).run();
  let row: DeliveryRow = { id: rowId, status: 'received', attempts: 1 };
  if (!inserted.meta.changes) {
    const existing = await c.env.DB.prepare('SELECT id, status, attempts FROM app_hook_deliveries WHERE app_id = ? AND hook = ? AND delivery_id = ?')
      .bind(appId, name, verified.deliveryId).first<DeliveryRow>();
    if (!existing || existing.status === 'received' || existing.status === 'delivered') return c.json({ duplicate: true }, 200);
    // A sender redelivering a failed delivery: only the request that wins this update proceeds.
    const retried = await c.env.DB.prepare(
      `UPDATE app_hook_deliveries SET status = 'received', attempts = attempts + 1, error = NULL, finished_at = NULL
        WHERE id = ? AND status IN ('failed', 'quota_exceeded') RETURNING attempts`,
    ).bind(existing.id).first<{ attempts: number }>();
    if (!retried) return c.json({ duplicate: true }, 200);
    row = { id: existing.id, status: 'received', attempts: retried.attempts };
  }

  try {
    const overrides = await c.env.DB.prepare('SELECT quota_overrides FROM app_workers WHERE app_id = ?').bind(appId).first<{ quota_overrides: string | null }>();
    await reserveHookDelivery(c.env, appId, quotasFrom(overrides?.quota_overrides), now);
  } catch (e) {
    const { error, status } = notProcessed(e instanceof AppWorkerQuotaError ? e : new Error('quota check unavailable'));
    await finish(c.env, row.id, error, status);
    return c.json({ accepted: true, delivery: row.id, processed: false }, 202);
  }

  const target = JSON.parse(hook.target) as HookTarget;
  const delivery: HookDelivery = { appId, hook: name, target, rowId: row.id, attempt: row.attempts, body, headers: c.req.raw.headers };
  let ctx: AppWorkerExports | undefined;
  try { ctx = c.executionCtx as unknown as AppWorkerExports; } catch { ctx = undefined; }
  runAfterResponse(c, deliverHook(c.env, delivery, ctx)
    .then((error) => finish(c.env, row.id, error), (e) => { const r = notProcessed(e); return finish(c.env, row.id, r.error, r.status); })
    .catch((e) => console.error(`[hooks] recording delivery ${row.id} failed: ${(e as Error)?.message ?? e}`)));
  return c.json({ accepted: true, delivery: row.id }, 202);
});

/** Never a secret value: only whether the named app secret exists. */
hookRoutes.get('/apps/:appId/hooks', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  const rows = await c.env.DB.prepare(
    `SELECT h.name, h.verify_kind, h.secret_name, h.target, s.name IS NOT NULL AS secret_set
       FROM app_hooks h LEFT JOIN app_secrets s ON s.app_id = h.app_id AND s.name = h.secret_name
      WHERE h.app_id = ? ORDER BY h.name`,
  ).bind(appId).all<{ name: string; verify_kind: string; secret_name: string | null; target: string; secret_set: number }>();
  const origin = new URL(c.req.url).origin;
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    hooks: (rows.results ?? []).map((h) => ({
      name: h.name,
      // github-app hooks are fed by the platform's GitHub App (#258), not a public URL.
      url: h.verify_kind === 'github-app' ? null : `${origin}/v1/apps/${appId}/hooks/${h.name}`,
      verify_kind: h.verify_kind,
      secret_name: h.secret_name,
      secret_set: h.secret_name ? h.secret_set === 1 : null,
      to: JSON.parse(h.target) as HookTarget,
    })),
  });
});

hookRoutes.get('/apps/:appId/hook-deliveries', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  const requested = Number(c.req.query('limit') ?? 50);
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50;
  const hook = c.req.query('hook');
  const status = c.req.query('status');
  if (status && !['received', 'delivered', 'failed', 'quota_exceeded'].includes(status)) throw new HttpError('invalid status', 400);
  const rows = await c.env.DB.prepare(
    `SELECT id, hook, delivery_id, event, received_at, status, attempts, finished_at, error
       FROM app_hook_deliveries WHERE app_id = ?${hook ? ' AND hook = ?' : ''}${status ? ' AND status = ?' : ''}
      ORDER BY received_at DESC LIMIT ?`,
  ).bind(appId, ...(hook ? [hook] : []), ...(status ? [status] : []), limit).all();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ deliveries: rows.results ?? [] });
});
