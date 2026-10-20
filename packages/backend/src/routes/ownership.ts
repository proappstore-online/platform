import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireAdmin, requireUser, type FasUser } from '../lib/auth.js';
import { wrap, privateNoStore } from '../lib/route-wrap.js';
import { sendEmail, normalizeEmail } from '../lib/email.js';
import { dataWorkerName } from '../lib/data-worker-url.js';
import { APP_ORG } from '../lib/app-deploy-oidc.js';

/**
 * App ownership transfer and recovery (#423).
 *
 * `apps.creator_id` changes in exactly two places, both guarded in one D1 batch
 * so a replay or a race can never move an app twice:
 * - the recipient accepts a pending `transfer` the current owner initiated;
 * - a platform admin approves an `escalated` row (a stuck transfer, or a
 *   `recovery` request from someone who is not the owner).
 *
 * Nothing here is reachable by an app being down or empty: a non-owner can only
 * file a recovery request, which waits for an admin. Every state change writes
 * `app_ownership_audit`, which migration 0105 makes append-only.
 *
 * The other party is only ever shown by login: never email, provider id or user
 * id. A recovery requester is not shown to the owner at all.
 */
export const ownershipRoutes = new Hono<{ Bindings: Env }>();
ownershipRoutes.use('/apps/:appId/ownership', privateNoStore);
ownershipRoutes.use('/apps/:appId/ownership/*', privateNoStore);

export const TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TEXT = 2000;
/** Providers that prove a real external identity. Credential (username/password) and child accounts do not. */
const VERIFIED_PROVIDERS = ['github', 'google'];
const UNVERIFIED_RECIPIENT =
  'recipient is not a verified PAS identity: they must have signed in to PAS with GitHub or Google. Pass their exact PAS user id if an email matches more than one account.';

export type TransferKind = 'transfer' | 'recovery';
export type TransferStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'escalated' | 'admin_approved';

export interface TransferRow {
  id: number;
  app_id: string;
  from_user: string;
  to_user: string;
  kind: TransferKind;
  status: TransferStatus;
  implications_snapshot: string | null;
  expiry_ms: number | null;
  admin_actor: string | null;
  admin_reason: string | null;
  created_ms: number;
  updated_ms: number;
}

interface AuditRow {
  id: number;
  transfer_id: number | null;
  actor: string;
  action: string;
  from_user: string | null;
  to_user: string | null;
  detail: string | null;
  created_ms: number;
}

/** A JSON object body (empty allowed), or a 400. */
async function jsonBody<T>(request: Request): Promise<Partial<T>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new HttpError('request body must be a JSON object', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('request body must be a JSON object', 400);
  return body as Partial<T>;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(`${field} must be a string`, 400);
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT) throw new HttpError(`${field} must be at most ${MAX_TEXT} characters`, 400);
  return trimmed || null;
}

async function loadApp(db: D1Database, appId: string): Promise<{ id: string; creator_id: string }> {
  const app = await db.prepare('SELECT id, creator_id FROM apps WHERE id = ?').bind(appId).first<{ id: string; creator_id: string }>();
  if (!app) throw new HttpError('app not found', 404);
  return app;
}

async function loadTransfer(db: D1Database, appId: string, rawId: string | undefined): Promise<TransferRow> {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError('transfer not found', 404);
  const row = await db.prepare('SELECT * FROM app_ownership_transfers WHERE id = ? AND app_id = ?').bind(id, appId).first<TransferRow>();
  if (!row) throw new HttpError('transfer not found', 404);
  return row;
}

/**
 * Resolve a recipient reference — a PAS user id (`gh:…`, `google:…`), an email,
 * or a GitHub login — to a verified user id. Every failure is the same message,
 * so the endpoint cannot be used to learn which emails have PAS accounts.
 */
async function resolveVerifiedRecipient(db: D1Database, ref: string): Promise<string> {
  const value = ref.trim();
  if (!value) throw new HttpError('to is required', 400);
  const placeholders = VERIFIED_PROVIDERS.map(() => '?').join(', ');
  const verified = `provider IN (${placeholders}) AND COALESCE(is_child, 0) = 0`;
  let rows: { id: string }[];
  if (value.includes('@')) {
    ({ results: rows } = await db
      .prepare(`SELECT id FROM users WHERE lower(email) = ? AND ${verified} LIMIT 2`)
      .bind(normalizeEmail(value), ...VERIFIED_PROVIDERS)
      .all<{ id: string }>());
  } else if (value.includes(':')) {
    ({ results: rows } = await db.prepare(`SELECT id FROM users WHERE id = ? AND ${verified}`).bind(value, ...VERIFIED_PROVIDERS).all<{ id: string }>());
  } else {
    ({ results: rows } = await db
      .prepare(`SELECT id FROM users WHERE provider = 'github' AND lower(login) = lower(?) AND ${verified} LIMIT 2`)
      .bind(value, ...VERIFIED_PROVIDERS)
      .all<{ id: string }>());
  }
  if (rows.length !== 1) throw new HttpError(UNVERIFIED_RECIPIENT, 400);
  return rows[0]!.id;
}

/** What changes hands, shown before anyone confirms and stored on the transfer row. */
async function buildImplications(db: D1Database, appId: string): Promise<Record<string, unknown>> {
  const count = async (sql: string, ...args: unknown[]) =>
    (await db.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;
  const repository = `${APP_ORG}/${appId}`;
  const [app, domains, worker, team, licences, grants] = await Promise.all([
    db.prepare('SELECT created_at, template_id, d1_database_id FROM apps WHERE id = ?').bind(appId)
      .first<{ created_at: number; template_id: string | null; d1_database_id: string | null }>(),
    db.prepare('SELECT domain FROM app_custom_domains WHERE app_id = ? ORDER BY domain').bind(appId).all<{ domain: string }>(),
    db.prepare('SELECT enabled FROM app_workers WHERE app_id = ?').bind(appId).first<{ enabled: number }>(),
    count('SELECT COUNT(*) AS n FROM team_members WHERE app_id = ?', appId),
    count('SELECT COUNT(*) AS n FROM licenses WHERE app_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)', appId, Date.now()),
    count('SELECT COUNT(*) AS n FROM oidc_session_grants WHERE repository = ? AND revoked_at IS NULL', repository),
  ]);
  return {
    app: { id: appId, created_at: app?.created_at ?? null, template: app?.template_id ?? null },
    repository: {
      full_name: repository,
      effect: `The repository stays in the ${APP_ORG} organisation. The new owner gets the owner's access to it through PAS; the previous owner loses it.`,
    },
    route: {
      url: `https://${appId}.proappstore.online`,
      custom_domains: domains.results.map((d) => d.domain),
      effect: 'Routes and custom domains keep serving; nothing is redeployed by the transfer.',
    },
    data_worker: {
      name: dataWorkerName(appId),
      database: app?.d1_database_id ? 'provisioned' : 'none',
      effect: 'App data stays where it is and is not copied or exported. The new owner controls its schema, secrets and deletion.',
    },
    app_worker: { enabled: worker?.enabled === 1 },
    deploy: {
      active_ci_session_grants: grants,
      effect: 'Deploys keep running from the repository. CI session grants keep their designated account; review them after the transfer.',
    },
    team: {
      members: team,
      effect: 'Team members keep their roles. The previous owner keeps no access unless the new owner adds them to the team.',
    },
    billing: {
      active_licences: licences,
      effect: "Subscriber licences and the app's storefront listing follow the app. Neither owner's own PAS plan changes.",
    },
  };
}

/** Best-effort email to a user's own address. Never blocks or fails the transition: the audit row is the record. */
async function notify(env: Env, userId: string, subject: string, text: string): Promise<void> {
  try {
    if (!env.RESEND_API_KEY) return;
    const user = await env.DB.prepare('SELECT COALESCE(email, credential_email) AS email FROM users WHERE id = ?')
      .bind(userId)
      .first<{ email: string | null }>();
    if (!user?.email) return;
    const html = `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`;
    await sendEmail(
      { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM ?? 'ProAppStore <noreply@proappstore.online>' },
      { to: user.email, subject, text, html },
    );
  } catch (err) {
    console.error(`[ownership] notification to ${userId} failed: ${(err as Error).message}`);
  }
}

async function loginOf(db: D1Database, userId: string): Promise<string | null> {
  return (await db.prepare('SELECT login FROM users WHERE id = ?').bind(userId).first<{ login: string }>())?.login ?? null;
}

function auditStmt(db: D1Database, t: Pick<TransferRow, 'id' | 'app_id' | 'from_user' | 'to_user'>, actor: string, action: string, detail: unknown, guard?: { status: TransferStatus; now: number }) {
  const values = [t.app_id, t.id, actor, action, t.from_user, t.to_user, detail === undefined ? null : JSON.stringify(detail)];
  if (!guard) {
    return db.prepare(
      'INSERT INTO app_ownership_audit (app_id, transfer_id, actor, action, from_user, to_user, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(...values);
  }
  // Inside a batch: only when this request's transition actually applied, and once.
  return db.prepare(
    `INSERT INTO app_ownership_audit (app_id, transfer_id, actor, action, from_user, to_user, detail)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM app_ownership_transfers WHERE id = ?2 AND status = ? AND updated_ms = ?)
       AND NOT EXISTS (SELECT 1 FROM app_ownership_audit WHERE app_id = ?1 AND transfer_id = ?2 AND action = ?4)`,
  ).bind(...values, guard.status, guard.now);
}

/** Move a row between non-ownership states (decline, cancel, escalate, expire), audited atomically. */
async function transition(
  env: Env,
  t: TransferRow,
  from: TransferStatus[],
  to: TransferStatus,
  actor: string,
  action: string,
  detail?: unknown,
): Promise<boolean> {
  const now = Date.now();
  const placeholders = from.map(() => '?').join(', ');
  const [update] = await env.DB.batch([
    env.DB.prepare(`UPDATE app_ownership_transfers SET status = ?, updated_ms = ? WHERE id = ? AND status IN (${placeholders})`)
      .bind(to, now, t.id, ...from),
    auditStmt(env.DB, t, actor, action, detail, { status: to, now }),
  ]);
  return (update?.meta.changes ?? 0) > 0;
}

function isExpired(t: TransferRow, now = Date.now()): boolean {
  return t.status === 'pending' && t.expiry_ms !== null && t.expiry_ms <= now;
}

/** A pending row past its expiry is marked expired (and audited) the first time anyone touches it. */
async function settleExpiry(env: Env, t: TransferRow): Promise<TransferRow> {
  if (!isExpired(t)) return t;
  await transition(env, t, ['pending'], 'expired', 'system', 'expired');
  return { ...t, status: 'expired' };
}

/**
 * Change `apps.creator_id` from `t.from_user` to `t.to_user`, mark the row
 * `to`, supersede every other open row for the app, and audit — one batch.
 * Applies only while the row is still in `expect` and the app is still owned by
 * `from_user`; returns whether it did.
 */
async function moveOwnership(
  env: Env,
  t: TransferRow,
  expect: TransferStatus,
  to: 'accepted' | 'admin_approved',
  actor: string,
  detail: Record<string, unknown>,
  admin?: { actor: string; reason: string },
): Promise<boolean> {
  const db = env.DB;
  const now = Date.now();
  // A pending row must also be unexpired at the moment of the write.
  const live = expect === 'pending' ? 'AND (expiry_ms IS NULL OR expiry_ms > ?)' : '';
  const liveArgs = expect === 'pending' ? [now] : [];
  const results = await db.batch([
    db.prepare(
      `UPDATE apps SET creator_id = ? WHERE id = ? AND creator_id = ?
         AND EXISTS (SELECT 1 FROM app_ownership_transfers WHERE id = ? AND app_id = ? AND to_user = ? AND status = ? ${live})`,
    ).bind(t.to_user, t.app_id, t.from_user, t.id, t.app_id, t.to_user, expect, ...liveArgs),
    db.prepare(
      `UPDATE app_ownership_transfers SET status = ?, updated_ms = ?, admin_actor = COALESCE(?, admin_actor), admin_reason = COALESCE(?, admin_reason)
       WHERE id = ? AND status = ? AND EXISTS (SELECT 1 FROM apps WHERE id = ? AND creator_id = ?)`,
    ).bind(to, now, admin?.actor ?? null, admin?.reason ?? null, t.id, expect, t.app_id, t.to_user),
    auditStmt(db, t, actor, to, detail, { status: to, now }),
    // Every other open row was about the previous owner; record, then close it.
    db.prepare(
      `INSERT INTO app_ownership_audit (app_id, transfer_id, actor, action, from_user, to_user, detail)
       SELECT app_id, id, 'system', 'superseded', from_user, to_user, ?
       FROM app_ownership_transfers
       WHERE app_id = ? AND id != ? AND status IN ('pending', 'escalated')
         AND EXISTS (SELECT 1 FROM app_ownership_transfers WHERE id = ? AND status = ? AND updated_ms = ?)`,
    ).bind(JSON.stringify({ by_transfer: t.id }), t.app_id, t.id, t.id, to, now),
    db.prepare(
      `UPDATE app_ownership_transfers SET status = 'cancelled', updated_ms = ?
       WHERE app_id = ? AND id != ? AND status IN ('pending', 'escalated')
         AND EXISTS (SELECT 1 FROM app_ownership_transfers WHERE id = ? AND status = ? AND updated_ms = ?)`,
    ).bind(now, t.app_id, t.id, t.id, to, now),
  ]);
  return (results[1]?.meta.changes ?? 0) > 0;
}

type Relationship = 'owner' | 'sender' | 'recipient' | 'requester' | 'admin' | 'none';

function relationshipTo(t: TransferRow, viewer: FasUser, admin: boolean): Relationship {
  if (admin) return 'admin';
  if (t.to_user === viewer.id) return t.kind === 'recovery' ? 'requester' : 'recipient';
  if (t.from_user === viewer.id) return 'sender';
  return 'none';
}

/** A transfer as the viewer may see it: logins of the parties, never ids or emails (admins excepted). */
async function presentTransfer(db: D1Database, t: TransferRow, viewer: FasUser, admin: boolean) {
  const rel = relationshipTo(t, viewer, admin);
  const status = isExpired(t) ? 'expired' : t.status;
  // A recovery request is unproven until an admin decides it: the owner never
  // learns who filed it, and the requester never learns who the owner is or
  // what the app holds.
  const recoveryParty = t.kind === 'recovery' && !admin;
  return {
    id: t.id,
    kind: t.kind,
    status,
    you: rel,
    from: recoveryParty && rel === 'requester' ? null : { login: await loginOf(db, t.from_user), ...(admin ? { user_id: t.from_user } : {}) },
    to: recoveryParty && rel === 'sender' ? null : { login: await loginOf(db, t.to_user), ...(admin ? { user_id: t.to_user } : {}) },
    implications: t.implications_snapshot && !(recoveryParty && rel === 'requester') ? JSON.parse(t.implications_snapshot) : null,
    expires_at_ms: t.expiry_ms,
    created_ms: t.created_ms,
    updated_ms: t.updated_ms,
    resolution: t.admin_reason ? { reason: t.admin_reason, ...(admin ? { admin: t.admin_actor } : {}) } : null,
  };
}

function presentAudit(rows: AuditRow[], viewer: FasUser, admin: boolean) {
  return rows.map((r) => {
    const by = admin
      ? r.actor
      : r.actor === viewer.id ? 'you'
        : r.actor === 'system' ? 'system'
          : r.actor === r.from_user ? 'sender'
            : r.actor === r.to_user ? 'recipient'
              : 'platform admin';
    let detail: unknown = r.detail ? JSON.parse(r.detail) : null;
    // Recovery evidence is for the requester and admins only.
    if (!admin && r.actor !== viewer.id && detail && typeof detail === 'object' && 'evidence' in detail) {
      detail = { ...(detail as Record<string, unknown>), evidence: '[withheld]' };
    }
    return { id: r.id, transfer_id: r.transfer_id, action: r.action, by, detail, at_ms: r.created_ms };
  });
}

/** #429: recovery requests one account may file for one app per rolling day. */
export const MAX_RECOVERY_REQUESTS_PER_DAY = 3;
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── read-only status ─────────────────────────────────────────

/**
 * The caller's relationship to the app's ownership. Any signed-in user may ask:
 * a non-party learns only that they are not the owner and may file a recovery
 * request — never who the owner is.
 */
ownershipRoutes.get('/apps/:appId/ownership', wrap(async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;
  const app = await loadApp(c.env.DB, appId);
  const admin = user.roles.includes('admin');
  const isOwner = app.creator_id === user.id;

  const { results: all } = await c.env.DB.prepare('SELECT * FROM app_ownership_transfers WHERE app_id = ? ORDER BY id DESC')
    .bind(appId)
    .all<TransferRow>();
  // The owner sees the transfers they sent and that recovery requests exist; a
  // party sees the rows they are on; an admin sees all.
  const visible = all.filter((t) => admin || t.to_user === user.id || t.from_user === user.id);
  const relationship: Relationship = admin ? 'admin' : isOwner ? 'owner' : visible.some((t) => t.to_user === user.id)
    ? (visible.find((t) => t.to_user === user.id)!.kind === 'recovery' ? 'requester' : 'recipient')
    : visible.length > 0 ? 'sender' : 'none';

  if (relationship === 'none') {
    return c.json({
      app_id: appId,
      you: 'none',
      owner: null,
      can_request_recovery: true,
      message: 'You do not own this app. If you created it with another sign-in, file a recovery request; a platform admin reviews it. Ownership never changes because an app is down or empty.',
    });
  }

  // #429: a join on the same visibility rule, not one bound parameter per visible
  // row: D1 allows 100, so an app with 100+ visible rows answered 500.
  const { results: audit } = visible.length
    ? await c.env.DB.prepare(
      `SELECT au.* FROM app_ownership_audit au JOIN app_ownership_transfers t ON t.id = au.transfer_id AND t.app_id = au.app_id
        WHERE au.app_id = ?1 AND (?2 = 1 OR t.to_user = ?3 OR t.from_user = ?3) ORDER BY au.id`,
    ).bind(appId, admin ? 1 : 0, user.id).all<AuditRow>()
    : { results: [] as AuditRow[] };

  const open = visible.filter((t) => (t.status === 'pending' && !isExpired(t)) || t.status === 'escalated');
  return c.json({
    app_id: appId,
    you: relationship,
    owner: isOwner || admin ? { login: await loginOf(c.env.DB, app.creator_id), ...(admin ? { user_id: app.creator_id } : {}) } : null,
    can_request_recovery: !isOwner && !admin,
    open: await Promise.all(open.map((t) => presentTransfer(c.env.DB, t, user, admin))),
    history: await Promise.all(visible.filter((t) => !open.includes(t)).map((t) => presentTransfer(c.env.DB, t, user, admin))),
    audit: presentAudit(audit, user, admin),
  });
}));

// ── owner-initiated transfer ─────────────────────────────────

/**
 * The current owner (the app's creator — not an admin, not a team `owner`)
 * offers the app to a verified PAS identity. `dry_run: true` returns the
 * implications without creating anything.
 */
ownershipRoutes.post('/apps/:appId/ownership/transfer', wrap(async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;
  const app = await loadApp(c.env.DB, appId);
  if (app.creator_id !== user.id) throw new HttpError('only the app owner can transfer it', 403);
  const body = await jsonBody<{ to: string; message: string; dry_run: boolean }>(c.req.raw);
  if (typeof body.to !== 'string') throw new HttpError('to is required: a PAS user id, email, or GitHub login', 400);
  const message = optionalText(body.message, 'message');

  const toUser = await resolveVerifiedRecipient(c.env.DB, body.to);
  if (toUser === user.id) throw new HttpError('you already own this app', 400);
  const implications = await buildImplications(c.env.DB, appId);
  const recipientLogin = await loginOf(c.env.DB, toUser);
  if (body.dry_run === true) {
    return c.json({ dry_run: true, app_id: appId, to: { login: recipientLogin }, implications, expires_in_ms: TRANSFER_TTL_MS });
  }

  const { results: open } = await c.env.DB.prepare(
    "SELECT * FROM app_ownership_transfers WHERE app_id = ? AND kind = 'transfer' AND status = 'pending'",
  ).bind(appId).all<TransferRow>();
  for (const t of open) {
    if ((await settleExpiry(c.env, t)).status === 'pending') {
      throw new HttpError('a transfer of this app is already pending: cancel it first', 409);
    }
  }

  const now = Date.now();
  const expiry = now + TRANSFER_TTL_MS;
  const row = await c.env.DB.prepare(
    `INSERT INTO app_ownership_transfers (app_id, from_user, to_user, kind, status, implications_snapshot, expiry_ms, created_ms, updated_ms)
     VALUES (?, ?, ?, 'transfer', 'pending', ?, ?, ?, ?) RETURNING *`,
  ).bind(appId, user.id, toUser, JSON.stringify(implications), expiry, now, now).first<TransferRow>();
  if (!row) throw new HttpError('transfer could not be created', 500);
  await auditStmt(c.env.DB, row, user.id, 'initiated', { expiry_ms: expiry, ...(message ? { message } : {}) }).run();

  await Promise.all([
    notify(c.env, toUser, `${user.login} wants to transfer ${appId} to you`,
      `${user.login} has offered you ownership of the PAS app "${appId}".${message ? `\n\nTheir message: ${message}` : ''}\n\nReview what changes hands and accept or decline before ${new Date(expiry).toISOString()}. Nothing changes until you accept.`),
    notify(c.env, user.id, `Transfer of ${appId} started`,
      `You offered ownership of "${appId}" to ${recipientLogin ?? 'another account'}. It expires ${new Date(expiry).toISOString()} unless they accept; you can cancel it until then.`),
  ]);
  return c.json({ transfer: await presentTransfer(c.env.DB, row, user, false) }, 201);
}));

/** The recipient accepts: ownership moves now, if the row is still pending, unexpired, and the sender still owns the app. */
ownershipRoutes.post('/apps/:appId/ownership/transfer/:transferId/accept', wrap(async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;
  await loadApp(c.env.DB, appId);
  // #429: who may act is checked before expiry is settled, so a stranger's call
  // cannot mark someone else's transfer expired (which then refused its escalation).
  const loaded = await loadTransfer(c.env.DB, appId, c.req.param('transferId'));
  if (loaded.kind !== 'transfer' || loaded.to_user !== user.id) throw new HttpError('only the recipient can accept this transfer', 403);
  const t = await settleExpiry(c.env, loaded);
  if (t.status === 'expired') throw new HttpError('this transfer has expired', 410);
  if (t.status !== 'pending') throw new HttpError(`this transfer is ${t.status}`, 409);

  const moved = await moveOwnership(c.env, t, 'pending', 'accepted', user.id, {});
  if (!moved) throw new HttpError('this transfer can no longer be accepted: the app or the transfer changed', 409);

  const subject = `Ownership of ${appId} transferred`;
  await Promise.all([
    notify(c.env, t.from_user, subject, `${user.login} accepted ownership of "${appId}". You no longer own it. The audit record is at GET /v1/apps/${appId}/ownership.`),
    notify(c.env, t.to_user, subject, `You now own "${appId}". The audit record is at GET /v1/apps/${appId}/ownership.`),
  ]);
  const updated = await loadTransfer(c.env.DB, appId, String(t.id));
  return c.json({ transfer: await presentTransfer(c.env.DB, updated, user, false) });
}));

ownershipRoutes.post('/apps/:appId/ownership/transfer/:transferId/decline', wrap(async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;
  await loadApp(c.env.DB, appId);
  // #429: who may act is checked before expiry is settled, so a stranger's call
  // cannot mark someone else's transfer expired (which then refused its escalation).
  const loaded = await loadTransfer(c.env.DB, appId, c.req.param('transferId'));
  if (loaded.kind !== 'transfer' || loaded.to_user !== user.id) throw new HttpError('only the recipient can decline this transfer', 403);
  const t = await settleExpiry(c.env, loaded);
  if (t.status === 'expired') throw new HttpError('this transfer has expired', 410);
  if (t.status !== 'pending') throw new HttpError(`this transfer is ${t.status}`, 409);
  if (!(await transition(c.env, t, ['pending'], 'declined', user.id, 'declined'))) throw new HttpError('this transfer changed', 409);
  await notify(c.env, t.from_user, `Transfer of ${appId} declined`, `${user.login} declined ownership of "${appId}". You still own it.`);
  return c.json({ transfer: await presentTransfer(c.env.DB, { ...t, status: 'declined' }, user, false) });
}));

/**
 * The sender withdraws a transfer; the requester withdraws a recovery request.
 * The owner cannot cancel a recovery request against their app — an admin decides it.
 */
ownershipRoutes.post('/apps/:appId/ownership/transfer/:transferId/cancel', wrap(async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;
  await loadApp(c.env.DB, appId);
  const loaded = await loadTransfer(c.env.DB, appId, c.req.param('transferId'));
  const canCancel = loaded.kind === 'transfer' ? loaded.from_user === user.id : loaded.to_user === user.id;
  if (!canCancel) throw new HttpError(loaded.kind === 'transfer' ? 'only the sender can cancel this transfer' : 'only the requester can withdraw this recovery request', 403);
  const t = await settleExpiry(c.env, loaded);
  if (t.status !== 'pending' && t.status !== 'escalated') throw new HttpError(`this transfer is ${t.status}`, 409);
  if (!(await transition(c.env, t, ['pending', 'escalated'], 'cancelled', user.id, 'cancelled'))) throw new HttpError('this transfer changed', 409);
  if (t.kind === 'transfer') {
    await notify(c.env, t.to_user, `Transfer of ${appId} cancelled`, `The offer of ownership of "${appId}" was withdrawn.`);
  }
  return c.json({ transfer: await presentTransfer(c.env.DB, { ...t, status: 'cancelled' }, user, false) });
}));

/** Either party hands a pending transfer to a platform admin (e.g. the recipient cannot sign in as the invited account). */
ownershipRoutes.post('/apps/:appId/ownership/transfer/:transferId/escalate', wrap(async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;
  await loadApp(c.env.DB, appId);
  const t = await loadTransfer(c.env.DB, appId, c.req.param('transferId'));
  if (t.kind !== 'transfer' || (t.from_user !== user.id && t.to_user !== user.id)) {
    throw new HttpError('only a party to this transfer can escalate it', 403);
  }
  // An expired transfer may still be escalated: that is the stuck case. #429: so
  // may one already marked expired (by the recipient's 410 on accept, or by the
  // owner starting another), which this used to refuse.
  if (t.status !== 'pending' && t.status !== 'expired') throw new HttpError(`this transfer is ${t.status}`, 409);
  const reason = optionalText((await jsonBody<{ reason: string }>(c.req.raw)).reason, 'reason');
  if (!(await transition(c.env, t, ['pending', 'expired'], 'escalated', user.id, 'escalated', reason ? { reason } : undefined))) {
    throw new HttpError('this transfer changed', 409);
  }
  const other = t.from_user === user.id ? t.to_user : t.from_user;
  await notify(c.env, other, `Transfer of ${appId} sent for review`, `The transfer of "${appId}" was sent to a platform admin for review. Ownership does not change until an admin decides.`);
  return c.json({ transfer: await presentTransfer(c.env.DB, { ...t, status: 'escalated' }, user, false) });
}));

// ── recovery request (the caller is not the owner) ───────────

/**
 * Someone who believes they created the app under another sign-in asks for it.
 * The request goes straight to admin review and never moves ownership by itself;
 * the owner is told a request exists, not who filed it.
 */
ownershipRoutes.post('/apps/:appId/ownership/recovery', wrap(async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;
  const app = await loadApp(c.env.DB, appId);
  if (app.creator_id === user.id) throw new HttpError('you already own this app', 400);
  // The requester must themselves be a verified identity: no credential or child accounts.
  await resolveVerifiedRecipient(c.env.DB, user.id).catch(() => {
    throw new HttpError('recovery requests need a verified PAS identity: sign in with GitHub or Google', 400);
  });
  const evidence = optionalText((await jsonBody<{ evidence: string }>(c.req.raw)).evidence, 'evidence');
  if (!evidence) throw new HttpError('evidence is required: how you can show you created this app (e.g. the other sign-in, the repository, commits)', 400);

  const existing = await c.env.DB.prepare(
    "SELECT id FROM app_ownership_transfers WHERE app_id = ? AND kind = 'recovery' AND to_user = ? AND status = 'escalated'",
  ).bind(appId, user.id).first<{ id: number }>();
  if (existing) throw new HttpError('you already have an open recovery request for this app', 409);
  // #429: file-and-withdraw was unlimited, and each filing emails the owner.
  const recent = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM app_ownership_transfers WHERE app_id = ? AND kind = 'recovery' AND to_user = ? AND created_ms > ?",
  ).bind(appId, user.id, Date.now() - RECOVERY_WINDOW_MS).first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_RECOVERY_REQUESTS_PER_DAY) {
    throw new HttpError(`at most ${MAX_RECOVERY_REQUESTS_PER_DAY} recovery requests for this app per day`, 429);
  }

  const implications = await buildImplications(c.env.DB, appId);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `INSERT INTO app_ownership_transfers (app_id, from_user, to_user, kind, status, implications_snapshot, expiry_ms, created_ms, updated_ms)
     VALUES (?, ?, ?, 'recovery', 'escalated', ?, NULL, ?, ?) RETURNING *`,
  ).bind(appId, app.creator_id, user.id, JSON.stringify(implications), now, now).first<TransferRow>();
  if (!row) throw new HttpError('recovery request could not be created', 500);
  await auditStmt(c.env.DB, row, user.id, 'recovery_requested', { evidence }).run();

  await Promise.all([
    notify(c.env, app.creator_id, `Ownership recovery requested for ${appId}`,
      `Someone has asked a platform admin to recover ownership of "${appId}". Nothing changes unless an admin approves it after review. If you did not expect this, reply to PAS support.`),
    notify(c.env, user.id, `Recovery request for ${appId} received`,
      `Your request to recover "${appId}" is with a platform admin. Ownership does not change until they decide.`),
  ]);
  return c.json({ transfer: await presentTransfer(c.env.DB, row, user, false) }, 201);
}));

// ── admin resolution ─────────────────────────────────────────

/**
 * A platform admin decides an escalated row. A reason is required and recorded.
 * An admin may not approve a move to themselves, and approval only applies
 * while the app is still owned by the account the row was filed against.
 */
ownershipRoutes.post('/admin/apps/:appId/ownership/transfer/:transferId/resolve', wrap(async (c) => {
  const admin = await requireAdmin(c);
  const appId = c.req.param('appId')!;
  const app = await loadApp(c.env.DB, appId);
  const t = await loadTransfer(c.env.DB, appId, c.req.param('transferId'));
  const body = await jsonBody<{ action: string; reason: string }>(c.req.raw);
  if (body.action !== 'approve' && body.action !== 'decline') throw new HttpError("action must be 'approve' or 'decline'", 400);
  const reason = optionalText(body.reason, 'reason');
  if (!reason) throw new HttpError('reason is required', 400);
  if (t.status !== 'escalated') throw new HttpError(`only escalated transfers can be resolved (this one is ${t.status})`, 409);

  if (body.action === 'decline') {
    const now = Date.now();
    const [update] = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE app_ownership_transfers SET status = 'declined', updated_ms = ?, admin_actor = ?, admin_reason = ? WHERE id = ? AND status = 'escalated'",
      ).bind(now, admin.id, reason, t.id),
      auditStmt(c.env.DB, t, admin.id, 'admin_declined', { reason }, { status: 'declined', now }),
    ]);
    if ((update?.meta.changes ?? 0) === 0) throw new HttpError('this transfer changed', 409);
    await Promise.all([
      notify(c.env, t.from_user, `Ownership review for ${appId}: no change`, `A platform admin reviewed an ownership request for "${appId}" and made no change. Reason: ${reason}`),
      notify(c.env, t.to_user, `Ownership review for ${appId}: declined`, `A platform admin declined the ownership request for "${appId}". Reason: ${reason}`),
    ]);
  } else {
    if (t.to_user === admin.id) throw new HttpError('an admin cannot approve a transfer to themselves: another admin must', 403);
    if (app.creator_id !== t.from_user) throw new HttpError('the app changed owner since this request was filed: decline it and file a new one', 409);
    const moved = await moveOwnership(c.env, t, 'escalated', 'admin_approved', admin.id, { reason }, { actor: admin.id, reason });
    if (!moved) throw new HttpError('this transfer can no longer be approved: the app or the transfer changed', 409);
    await Promise.all([
      notify(c.env, t.from_user, `Ownership of ${appId} moved by a platform admin`, `After review, a platform admin moved ownership of "${appId}" to another account. You no longer own it. Reason: ${reason}`),
      notify(c.env, t.to_user, `You now own ${appId}`, `After review, a platform admin made you the owner of "${appId}". Reason: ${reason}`),
    ]);
  }
  const updated = await loadTransfer(c.env.DB, appId, String(t.id));
  return c.json({ transfer: await presentTransfer(c.env.DB, updated, admin, true) });
}));
