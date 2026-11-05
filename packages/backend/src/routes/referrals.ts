import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireAppOwner, requireUser } from '../lib/auth.js';
import { APP_CONTEXT_HEADER } from '../lib/app-context.js';
import { privateNoStore, wrap } from '../lib/route-wrap.js';
import { person } from './promoters.js';
import { claim, correct, listEvents, listForOwner, listOwn } from '../lib/referrals/service.js';

/**
 * Referral capture and attribution (#550, epic #548). A referred person is credited to a promoter once, by the
 * server's own record of their first authenticated activation of the app (see lib/referrals/activation.ts). This
 * file is the capture primitive, the promoter's own read, and the owner's review and correction controls.
 *
 *   POST /v1/apps/:appId/referrals/claim                 the referred person, from inside the app: { code }
 *   GET  /v1/apps/:appId/promoters/me/referrals          the promoter: own pending/confirmed totals and rows
 *   GET  /v1/apps/:appId/referrals?status=&promoter_id=  owner: attributions with counts
 *   GET  /v1/apps/:appId/referrals/events                owner: the audit trail
 *   POST /v1/apps/:appId/referrals/:id/reverse           owner: { kind: 'fraud_invalid' | 'correction', reason? }
 *   POST /v1/apps/:appId/referrals/:id/restore           owner: undo a reversal
 *
 * No money moves: nothing here is a commission, a payout or a revenue rule.
 */
export const referralRoutes = new Hono<{ Bindings: Env }>();

referralRoutes.use('/apps/:appId/referrals', privateNoStore);
referralRoutes.use('/apps/:appId/referrals/*', privateNoStore);
referralRoutes.use('/apps/:appId/promoters/me/referrals', privateNoStore);

const body = (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => null) as Promise<Record<string, unknown> | null>;

/**
 * The referred person claims a code from inside the app. Only a request the host mediated for THIS app, carrying a
 * session bound to this app, can capture: a direct API call, a first-party session or another app's session gets
 * `unverified_origin` and nothing is stored (as with usage pings, #58). The answer is a state, never the promoter.
 */
referralRoutes.post('/apps/:appId/referrals/claim', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireUser(c);
  const context = user.credentialContext;
  if (c.req.header(APP_CONTEXT_HEADER) !== appId || context?.kind !== 'app_bound' || context.appId !== appId || user.via) {
    return c.json({ credited: false, state: 'unverified_origin' });
  }
  return c.json(await claim(c.env.DB, appId, user.id, (await body(c))?.code));
}));

referralRoutes.get('/apps/:appId/promoters/me/referrals', wrap(async (c) => {
  const user = await person(c);
  return c.json(await listOwn(c.env.DB, c.req.param('appId')!, user.id, { limit: c.req.query('limit'), before_id: c.req.query('before_id') }));
}));

referralRoutes.get('/apps/:appId/referrals/events', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  return c.json(await listEvents(c.env.DB, appId, { attribution_id: c.req.query('referral_id'), limit: c.req.query('limit'), before_id: c.req.query('before_id') }));
}));

referralRoutes.get('/apps/:appId/referrals', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  return c.json(await listForOwner(c.env.DB, appId, { status: c.req.query('status'), promoter_id: c.req.query('promoter_id'), limit: c.req.query('limit'), before_id: c.req.query('before_id') }));
}));

for (const action of ['reverse', 'restore'] as const) {
  referralRoutes.post(`/apps/:appId/referrals/:referralId/${action}`, wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const owner = await requireAppOwner(c, appId);
    const input = (await body(c)) ?? {};
    if (typeof input !== 'object') throw new HttpError('JSON object required', 400);
    return c.json({ ok: true, referral: await correct(c.env.DB, appId, c.req.param('referralId')!, action, input, owner.id) });
  }));
}
