/**
 * Verified app email routes (#566).
 *
 *   GET    /v1/apps/:appId/email                              owner  - domains (with the DNS records to add), identities, limits, usage
 *   POST   /v1/apps/:appId/email/domains                      owner  - { domain, receiving? } claim a domain; returns the DNS records
 *   POST   /v1/apps/:appId/email/domains/:domain/verify       owner  - re-check DNS with the provider (proof of control)
 *   DELETE /v1/apps/:appId/email/domains/:domain              owner
 *   POST   /v1/apps/:appId/email/identities                   owner|editor - { address, displayName?, replyTo? } declare a sender (pending)
 *   POST   /v1/apps/:appId/email/identities/:id/approve       owner  - { allowExternal? } the owner's approval
 *   POST   /v1/apps/:appId/email/identities/:id/revoke        owner
 *   POST   /v1/apps/:appId/email/send                         owner|editor - { identity, to, subject, text?, html?, replyTo?, idempotencyKey }
 *   GET    /v1/apps/:appId/email/sends[/:id]                  owner|editor - the platform's send records
 *   GET    /v1/apps/:appId/email/suppressions                 owner
 *   POST   /v1/admin/email/apps/:appId                        admin  - kill switch + quota overrides
 *   POST   /v1/admin/email/apps/:appId/identities/:id/suspend admin  - kill switch for one identity
 *   POST   /v1/email/provider-events                          public - the provider's signed webhook (Svix); 401 unless the signature verifies
 *
 * Every refusal is `{ error, code }` with a stable `code` (lib/app-email.ts). `send`
 * has no `from`: the sender is the app's registered identity.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireAdmin, requireAppOwner, requireUser } from '../lib/auth.js';
import { appEmailAccess } from '../lib/app-email-access.js';
import {
  EmailError, approveIdentity, assertNoServerDecidedFields, claimDomain, declareIdentity, emailStatus, getSend, listSends, listSuppressions, removeDomain,
  revokeIdentity, sendAppEmail, setAppEmailControls, suspendIdentity, verifyDomainClaim,
} from '../lib/app-email.js';
import { applyProviderEvent } from '../lib/app-email-events.js';
import { verifyWebhook } from '../lib/resend.js';

export const appEmailRoutes = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;
const MAX_EVENT_BYTES = 1024 * 1024;

/** An EmailError becomes an HttpError carrying its stable code. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EmailError) throw new HttpError(e.message, e.status, { code: e.code });
    throw e;
  }
}

async function jsonBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new HttpError('a JSON object body is required', 400, { code: 'invalid_request' });
}

/** Owner, admin or editor of the app (the legacy `/v1/email/send` rule). */
async function requireEmailActor(c: Ctx, appId: string) {
  const user = await requireUser(c);
  const access = await appEmailAccess(c.env, user, appId);
  if (access === 'not_found') throw new HttpError('app not found', 404);
  if (access === 'forbidden') throw new HttpError('not authorized to use email for this app', 403);
  return user;
}

appEmailRoutes.get('/apps/:appId/email', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  c.header('Cache-Control', 'private, no-store');
  return c.json(await emailStatus(c.env, appId));
});

appEmailRoutes.post('/apps/:appId/email/domains', async (c) => {
  const appId = c.req.param('appId');
  const user = await requireAppOwner(c, appId);
  const body = await jsonBody(c);
  if (typeof body.domain !== 'string') throw new HttpError('domain is required', 400, { code: 'invalid_request' });
  return c.json(await guard(() => claimDomain(c.env, appId, body.domain as string, { receiving: body.receiving === true, isAdmin: user.roles.includes('admin') })), 201);
});

appEmailRoutes.post('/apps/:appId/email/domains/:domain/verify', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  return c.json(await guard(() => verifyDomainClaim(c.env, appId, c.req.param('domain'))));
});

appEmailRoutes.delete('/apps/:appId/email/domains/:domain', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  await guard(() => removeDomain(c.env, appId, c.req.param('domain')));
  return c.json({ ok: true });
});

appEmailRoutes.post('/apps/:appId/email/identities', async (c) => {
  const appId = c.req.param('appId');
  const user = await requireEmailActor(c, appId);
  const body = await jsonBody(c);
  return c.json(await guard(() => declareIdentity(c.env, appId, { address: body.address as string, displayName: body.displayName, replyTo: body.replyTo }, user.id)), 201);
});

appEmailRoutes.post('/apps/:appId/email/identities/:id/approve', async (c) => {
  const appId = c.req.param('appId');
  const user = await requireAppOwner(c, appId);
  const body = await jsonBody(c).catch(() => ({} as Record<string, unknown>)); // an empty body approves without external recipients
  return c.json(await guard(() => approveIdentity(c.env, appId, c.req.param('id'), { allowExternal: body.allowExternal === true }, user.id)));
});

appEmailRoutes.post('/apps/:appId/email/identities/:id/revoke', async (c) => {
  const appId = c.req.param('appId');
  const user = await requireAppOwner(c, appId);
  return c.json(await guard(() => revokeIdentity(c.env, appId, c.req.param('id'), user.id)));
});

appEmailRoutes.post('/apps/:appId/email/send', async (c) => {
  const appId = c.req.param('appId');
  const user = await requireEmailActor(c, appId);
  const body = await jsonBody(c);
  await guard(async () => assertNoServerDecidedFields(body));
  // No `from`, provider id or timestamp is read from the caller: the identity is the registered one.
  const result = await guard(() => sendAppEmail(c.env, {
    appId, identity: body.identity as string, to: body.to as string | string[], subject: body.subject as string,
    text: body.text as string | undefined, html: body.html as string | undefined, replyTo: body.replyTo as string | undefined,
    idempotencyKey: body.idempotencyKey as string, actor: `user:${user.id}`,
  }));
  return c.json(result, result.status === 'accepted' && !result.replayed ? 201 : 200);
});

appEmailRoutes.get('/apps/:appId/email/sends', async (c) => {
  const appId = c.req.param('appId');
  await requireEmailActor(c, appId);
  const requested = Number(c.req.query('limit') ?? 50);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ sends: await listSends(c.env, appId, Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50) });
});

appEmailRoutes.get('/apps/:appId/email/sends/:id', async (c) => {
  const appId = c.req.param('appId');
  await requireEmailActor(c, appId);
  c.header('Cache-Control', 'private, no-store');
  return c.json(await guard(() => getSend(c.env, appId, c.req.param('id'))));
});

appEmailRoutes.get('/apps/:appId/email/suppressions', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ suppressions: await listSuppressions(c.env, appId) });
});

// ── administrator kill switch ───────────────────────────────────────────────

appEmailRoutes.post('/admin/email/apps/:appId', async (c) => {
  const admin = await requireAdmin(c);
  const appId = c.req.param('appId');
  const body = await jsonBody(c);
  await guard(() => setAppEmailControls(c.env, appId, {
    suspended: body.suspended === true, reason: typeof body.reason === 'string' ? body.reason.slice(0, 300) : null,
    dailyLimit: body.dailyLimit as number | null | undefined, identityDailyLimit: body.identityDailyLimit as number | null | undefined, burstLimit: body.burstLimit as number | null | undefined,
  }, admin.id));
  return c.json(await emailStatus(c.env, appId));
});

appEmailRoutes.post('/admin/email/apps/:appId/identities/:id/suspend', async (c) => {
  await requireAdmin(c);
  const body = await jsonBody(c);
  return c.json(await guard(() => suspendIdentity(c.env, c.req.param('appId'), c.req.param('id'), body.suspended !== false, typeof body.reason === 'string' ? body.reason.slice(0, 300) : null)));
});

// ── provider webhook ────────────────────────────────────────────────────────

/**
 * The provider's signed event stream. Unsigned, forged and stale requests are 401 and touch
 * nothing; a repeat of an applied event is 200 `{ duplicate: true }`; a failure while applying
 * is 500 so the provider retries (every step is safe to repeat).
 */
appEmailRoutes.post('/email/provider-events', async (c) => {
  const secret = c.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return c.text('email events are not configured', 503);
  if (Number(c.req.header('content-length') ?? 0) > MAX_EVENT_BYTES) return c.text('body too large', 413);
  const raw = await c.req.text();
  if (raw.length > MAX_EVENT_BYTES) return c.text('body too large', 413);
  const eventId = await verifyWebhook(secret, raw, c.req.raw.headers);
  if (!eventId) return c.text('signature verification failed', 401);
  let event: unknown;
  try { event = JSON.parse(raw); } catch { return c.text('not JSON', 400); }
  if (!event || typeof event !== 'object') return c.text('not an event', 400);
  const applied = await applyProviderEvent(c.env, eventId, event as Record<string, unknown>);
  return c.json(applied ? { ok: true } : { ok: true, duplicate: true });
});
