import { Hono, type Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireAppOwner, requireUser } from '../lib/auth.js';
import { privateNoStore, wrap } from '../lib/route-wrap.js';
import {
  eligibleApps, enroll, getSettings, listEvents, listForOwner, ownDto, ownRelationship, ownRelationships, parseEnrollment, parseReturnPath,
  putSettings, renameSelf, resolveCode, setStatus, withdraw,
} from '../lib/promoters/service.js';

/**
 * App-scoped promoter enrollment (#549, epic #548). Enrolling lets an existing PAS user help grow one app and
 * get a public referral code for it. It grants no team, creator, publisher, operator or admin right, needs no
 * owned app, and never writes users, team_members or app roles. Counting the users a promoter brings is #550.
 *
 *   GET  /v1/storefront/promoters/apps                  public: apps that take promoters
 *   GET  /v1/storefront/promoters/code/:code            public: resolve a code to its app (404 unless live)
 *   GET  /v1/promoters/me                               person: my relationships across apps
 *   POST /v1/apps/:appId/promoters/enroll               person: { consent: true, display_name?, return_path? }
 *   GET  /v1/apps/:appId/promoters/me                   person: my relationship to this app
 *   PATCH /v1/apps/:appId/promoters/me                  person: { display_name }
 *   POST /v1/apps/:appId/promoters/me/withdraw          person: leave (an owner's suspension is not lifted by leaving)
 *   GET  /v1/apps/:appId/promoters                      owner: promoters of this app, with counts
 *   POST /v1/apps/:appId/promoters/:promoterId/status   owner: { status: 'active' | 'suspended', reason? }
 *   GET  /v1/apps/:appId/promoters/events               owner: the audit trail
 *   GET|PUT /v1/apps/:appId/promoters/settings          owner: { enrollment_open }
 */
export const promoterRoutes = new Hono<{ Bindings: Env }>();
type Ctx = Context<{ Bindings: Env }>;

promoterRoutes.use('/promoters/*', privateNoStore);
promoterRoutes.use('/apps/:appId/promoters', privateNoStore);
promoterRoutes.use('/apps/:appId/promoters/*', privateNoStore);

/** Only a person signed in as themselves: not an app-bound, workload or machine credential. */
export async function person(c: Ctx) {
  const user = await requireUser(c);
  if (user.via || user.credentialContext?.kind !== 'first_party_session') throw new HttpError('sign in as yourself to use the promoter workspace', 403);
  return user;
}
const body = (c: Ctx) => c.req.json().catch(() => null);

// ── Public ──────────────────────────────────────────────────────────────────

promoterRoutes.get('/storefront/promoters/apps', wrap(async (c) => {
  c.header('Cache-Control', 'public, max-age=60');
  return c.json(await eligibleApps(c.env.DB, { after: c.req.query('after'), limit: c.req.query('limit') }));
}));

promoterRoutes.get('/storefront/promoters/code/:code', wrap(async (c) => {
  c.header('Cache-Control', 'no-store');
  const resolved = await resolveCode(c.env.DB, c.req.param('code'));
  if (!resolved) return c.text('not found', 404);
  return c.json(resolved);
}));

// ── The signed-in person ────────────────────────────────────────────────────

promoterRoutes.get('/promoters/me', wrap(async (c) => {
  const user = await person(c);
  return c.json({ promoters: await ownRelationships(c.env.DB, user.id) });
}));

promoterRoutes.post('/apps/:appId/promoters/enroll', wrap(async (c) => {
  const user = await person(c);
  const appId = c.req.param('appId')!;
  const raw = await body(c);
  const input = parseEnrollment(raw);
  const returnPath = parseReturnPath((raw as Record<string, unknown>).return_path);
  const { promoter, created, reactivated } = await enroll(c.env.DB, appId, user.id, input);
  // The caller is already signed in: this response is all the Console needs to open the workspace, with no second login.
  return c.json({ ok: true, created, reactivated, promoter: ownDto(promoter), ...(returnPath ? { return_path: returnPath } : {}) }, created ? 201 : 200);
}));

promoterRoutes.get('/apps/:appId/promoters/me', wrap(async (c) => {
  const user = await person(c);
  const row = await ownRelationship(c.env.DB, c.req.param('appId')!, user.id);
  if (!row) throw new HttpError('not found', 404);
  return c.json({ promoter: ownDto(row) });
}));

promoterRoutes.patch('/apps/:appId/promoters/me', wrap(async (c) => {
  const user = await person(c);
  const raw = (await body(c)) as { display_name?: unknown } | null;
  if (!raw || typeof raw !== 'object') throw new HttpError('JSON object required', 400);
  return c.json({ promoter: ownDto(await renameSelf(c.env.DB, c.req.param('appId')!, user.id, raw.display_name)) });
}));

promoterRoutes.post('/apps/:appId/promoters/me/withdraw', wrap(async (c) => {
  const user = await person(c);
  return c.json({ ok: true, promoter: ownDto(await withdraw(c.env.DB, c.req.param('appId')!, user.id)) });
}));

// ── The app owner ───────────────────────────────────────────────────────────

promoterRoutes.get('/apps/:appId/promoters/events', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  return c.json(await listEvents(c.env.DB, appId, { promoter_id: c.req.query('promoter_id'), limit: c.req.query('limit'), before_id: c.req.query('before_id') }));
}));

promoterRoutes.get('/apps/:appId/promoters/settings', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  return c.json(await getSettings(c.env.DB, appId));
}));

promoterRoutes.put('/apps/:appId/promoters/settings', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  const owner = await requireAppOwner(c, appId);
  return c.json(await putSettings(c.env.DB, appId, await body(c), owner.id));
}));

promoterRoutes.get('/apps/:appId/promoters', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  return c.json(await listForOwner(c.env.DB, appId, { status: c.req.query('status'), limit: c.req.query('limit'), before_id: c.req.query('before_id') }));
}));

promoterRoutes.post('/apps/:appId/promoters/:promoterId/status', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  const owner = await requireAppOwner(c, appId);
  const raw = (await body(c)) as { status?: unknown; reason?: unknown } | null;
  if (!raw || typeof raw !== 'object') throw new HttpError('JSON object required', 400);
  return c.json({ ok: true, promoter: await setStatus(c.env.DB, appId, c.req.param('promoterId')!, raw.status, raw.reason, owner.id) });
}));
