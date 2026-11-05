import { HttpError } from '../auth.js';
import { normalizeCode } from '../promoters/codes.js';

/**
 * Server-owned referral attribution (#550, epic #548).
 *
 * A person is credited to a promoter by ONE authoritative server event: their **first authenticated activation
 * of the app**, i.e. the first successful, host-mediated platform request made from inside the app by an
 * app-bound session for that (app, person). Loading a page, clicking a link, generating a code or being issued a
 * token never counts: they involve no authenticated request from inside the app. The activation is recorded by
 * the server from the request (`activation.ts`); a client cannot send, forge or edit it.
 *
 * A claim carries only a public code. The server resolves it to a verified active promoter of THIS app; it never
 * trusts a client-supplied promoter. States: pending (a valid code was captured, no activation yet) -> confirmed
 * (the activation followed), or expired, or reversed by the owner. Unique by (app, referred person); the first
 * valid claim wins, and a later one never reassigns it.
 */

/** How long a captured, unconfirmed claim waits for the activation. */
export const CAPTURE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * A claim may arrive just after the first activation (the app's first request can beat the SDK's claim). It still
 * counts if the activation was within this window; an older activation (or any older evidence of use) means the
 * person was already an app user, and is never credited.
 */
export const ACTIVATION_GRACE_MS = 15 * 60 * 1000;

export type AttributionStatus = 'pending' | 'confirmed' | 'expired' | 'reversed';
type ClaimState = 'pending' | 'confirmed' | 'not_eligible' | 'invalid_code' | 'already_attributed' | 'unverified_origin';

interface Attribution {
  id: string; app_id: string; promoter_id: string; code: string; status: AttributionStatus; captured_at: number; expires_at: number;
  activated_at: number | null; confirmed_at: number | null; reversal_kind: string | null; reversal_reason: string | null; reversed_at: number | null;
  created_at: number;
}

const PUBLIC_APP = `NOT EXISTS (SELECT 1 FROM app_visibility v WHERE v.app_id = ?1 AND v.mode = 'private')`;
const ACTIVE_PROMOTER = (id: string) => `EXISTS (SELECT 1 FROM app_promoters p WHERE p.id = ${id} AND p.status = 'active')`;

/** What the referred person is told: a state and nothing about who the promoter is. */
export interface ClaimResult { credited: boolean; state: ClaimState }

// ── Activation (the authoritative event) ────────────────────────────────────

/**
 * Record `userId`'s activation of `appId` and, only on the FIRST one, settle any pending claim. One batch, so a
 * concurrent or replayed activation settles exactly once. A pending claim confirms only if its promoter is still
 * active and it has not expired; otherwise it expires (no credit, the person is organic). An erased person is not recorded.
 */
export async function recordActivation(db: D1Database, appId: string, userId: string, now = Date.now()): Promise<{ first: boolean; confirmed: boolean }> {
  // The common case, every request after the first: one indexed read, no write.
  if (await db.prepare('SELECT 1 FROM app_user_activations WHERE app_id = ? AND user_id = ?').bind(appId, userId).first()) return { first: false, confirmed: false };
  const live = `app_id = ?1 AND referred_user_id = ?2 AND status = 'pending'`;
  const eventFor = (action: string, to: AttributionStatus) => db.prepare(
    `INSERT INTO app_referral_events (id, app_id, attribution_id, promoter_id, actor_kind, action, from_status, to_status, reason, created_at)
       SELECT ?3, ?1, id, promoter_id, 'system', ?4, 'pending', ?5, NULL, ?6 FROM app_referral_attributions
        WHERE app_id = ?1 AND referred_user_id = ?2 AND status = ?5 AND updated_at = ?6 AND changes() > 0`,
  ).bind(appId, userId, crypto.randomUUID(), action, to, now);
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO app_user_activations (app_id, user_id, first_activated_at)
        SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM per_app_deleted_users d WHERE d.app_id = ?1 AND d.user_id = ?2)`).bind(appId, userId, now),
    db.prepare(`UPDATE app_referral_attributions SET status = 'confirmed', activated_at = ?3, confirmed_at = ?3, updated_at = ?3
        WHERE ${live} AND expires_at > ?3 AND ${ACTIVE_PROMOTER('promoter_id')} AND changes() > 0`).bind(appId, userId, now),
    eventFor('confirmed', 'confirmed'),
    db.prepare(`UPDATE app_referral_attributions SET status = 'expired', updated_at = ?3 WHERE ${live} AND (SELECT COUNT(*) FROM app_user_activations a WHERE a.app_id = ?1 AND a.user_id = ?2 AND a.first_activated_at = ?3) > 0`)
      .bind(appId, userId, now),
    eventFor('expired', 'expired'),
  ]);
  return { first: !!results[0]?.meta?.changes, confirmed: !!results[1]?.meta?.changes };
}

// ── Claim (capture across login) ────────────────────────────────────────────

/** Evidence the person used this app before `cutoff`: PAS's own ledger from now on, plus older records of use. Not a backfill: it is only read. */
const EXISTING_USER = `SELECT 1 AS found WHERE
  EXISTS (SELECT 1 FROM app_user_activations WHERE app_id = ?1 AND user_id = ?2 AND first_activated_at < ?3)
  OR EXISTS (SELECT 1 FROM kv WHERE app_id = ?1 AND user_id = ?2 AND updated_at < ?3)
  OR EXISTS (SELECT 1 FROM usage_daily WHERE app_id = ?1 AND user_id = ?2 AND day < strftime('%Y-%m-%d', ?3 / 1000, 'unixepoch'))
  OR EXISTS (SELECT 1 FROM app_roles WHERE app_id = ?1 AND user_id = ?2 AND granted_at < ?3)
  OR EXISTS (SELECT 1 FROM user_app_tokens WHERE app_id = ?1 AND user_id = ?2 AND created_at < ?3)
  OR EXISTS (SELECT 1 FROM push_subscriptions WHERE app_id = ?1 AND user_id = ?2 AND created_at < ?3)
  OR EXISTS (SELECT 1 FROM licenses WHERE app_id = ?1 AND user_id = ?2 AND issued_at < ?3)`;

function reject(db: D1Database, appId: string, promoterId: string, reason: string, now: number) {
  return db.prepare(
    `INSERT INTO app_referral_events (id, app_id, attribution_id, promoter_id, actor_kind, action, from_status, to_status, reason, created_at)
     VALUES (?, ?, NULL, ?, 'referred', 'claim_rejected', NULL, NULL, ?, ?)`,
  ).bind(crypto.randomUUID(), appId, promoterId, reason, now).run();
}

/**
 * Capture a referral for the signed-in person. Idempotent and safe to replay or race. An unknown, revoked,
 * suspended, withdrawn, other-app or private-app code is one identical `invalid_code`. A self-referral or a
 * person who already used the app is `not_eligible`, identically; the reason is audited, not revealed. If the
 * person already has a claim, the first one stands: the same promoter's replay returns its state, another's is
 * `already_attributed` and changes nothing.
 */
export async function claim(db: D1Database, appId: string, userId: string, codeInput: unknown, now = Date.now()): Promise<ClaimResult> {
  const code = normalizeCode(codeInput);
  const promoter = code ? await db.prepare(
    `SELECT p.id, p.user_id FROM app_promoters p WHERE p.code = ?2 AND p.app_id = ?1 AND p.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM app_visibility v WHERE v.app_id = p.app_id AND v.mode = 'private')`,
  ).bind(appId, code).first<{ id: string; user_id: string }>() : null;
  if (!code || !promoter) return { credited: false, state: 'invalid_code' };

  if (promoter.user_id === userId) { await reject(db, appId, promoter.id, 'self_referral', now); return { credited: false, state: 'not_eligible' }; }
  if (await db.prepare('SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?').bind(appId, userId).first()) return { credited: false, state: 'not_eligible' };

  const existing = await db.prepare('SELECT * FROM app_referral_attributions WHERE app_id = ? AND referred_user_id = ?').bind(appId, userId).first<Attribution>();
  if (existing?.status === 'pending' && existing.expires_at <= now) {
    // Its time ran out before any activation: it lapses (no credit) and the person may be claimed afresh.
    await db.batch([
      db.prepare("UPDATE app_referral_attributions SET status = 'expired', updated_at = ?2 WHERE id = ?1 AND status = 'pending' AND expires_at <= ?2").bind(existing.id, now),
      db.prepare(`INSERT INTO app_referral_events (id, app_id, attribution_id, promoter_id, actor_kind, action, from_status, to_status, reason, created_at)
          SELECT ?1, app_id, id, promoter_id, 'system', 'expired', 'pending', 'expired', 'capture expired', ?3 FROM app_referral_attributions WHERE id = ?2 AND changes() > 0`).bind(crypto.randomUUID(), existing.id, now),
    ]);
    existing.status = 'expired';
  }
  if (existing && existing.status !== 'expired') return answer(existing, promoter.id);
  if (await db.prepare(EXISTING_USER).bind(appId, userId, now - ACTIVATION_GRACE_MS).first()) {
    await reject(db, appId, promoter.id, 'existing_user', now);
    return { credited: false, state: 'not_eligible' };
  }

  // New, or a previous claim expired. The outcome is decided inside the statement: if the activation already
  // happened (within the grace window) the claim confirms now; otherwise it waits as pending for the activation.
  const id = crypto.randomUUID();
  const activated = `(SELECT first_activated_at FROM app_user_activations WHERE app_id = ?2 AND user_id = ?3)`;
  const guard = `${PUBLIC_APP.replace('?1', '?2')} AND ${ACTIVE_PROMOTER('?4')} AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users d WHERE d.app_id = ?2 AND d.user_id = ?3)`;
  const event = (attributionId: string) => db.prepare(
    `INSERT INTO app_referral_events (id, app_id, attribution_id, promoter_id, actor_kind, action, from_status, to_status, reason, created_at)
       SELECT ?1, ?2, id, promoter_id, 'referred', 'claimed', NULL, status, NULL, ?4 FROM app_referral_attributions WHERE id = ?3 AND changes() > 0`,
  ).bind(crypto.randomUUID(), appId, attributionId, now);
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO app_referral_attributions (id, app_id, referred_user_id, promoter_id, code, status, captured_at, expires_at, activated_at, confirmed_at, created_at, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5, CASE WHEN ${activated} IS NULL THEN 'pending' ELSE 'confirmed' END, ?6, ?7, ${activated}, CASE WHEN ${activated} IS NULL THEN NULL ELSE ?6 END, ?6, ?6
         WHERE ${guard}`).bind(id, appId, userId, promoter.id, code, now, now + CAPTURE_TTL_MS),
    event(id),
    db.prepare(`UPDATE app_referral_attributions SET promoter_id = ?4, code = ?5, captured_at = ?6, expires_at = ?7, updated_at = ?6, reversal_kind = NULL, reversal_reason = NULL, reversed_at = NULL,
          status = CASE WHEN ${activated} IS NULL THEN 'pending' ELSE 'confirmed' END,
          activated_at = ${activated}, confirmed_at = CASE WHEN ${activated} IS NULL THEN NULL ELSE ?6 END
        WHERE app_id = ?2 AND referred_user_id = ?3 AND status = 'expired' AND ${guard}`).bind(id, appId, userId, promoter.id, code, now, now + CAPTURE_TTL_MS),
    event(existing?.id ?? id),
  ]);
  const row = await db.prepare('SELECT * FROM app_referral_attributions WHERE app_id = ? AND referred_user_id = ?').bind(appId, userId).first<Attribution>();
  return row ? answer(row, promoter.id) : { credited: false, state: 'invalid_code' };
}

function answer(row: Attribution, promoterId: string): ClaimResult {
  if (row.promoter_id !== promoterId) return { credited: false, state: 'already_attributed' };
  if (row.status === 'confirmed') return { credited: true, state: 'confirmed' };
  if (row.status === 'pending') return { credited: false, state: 'pending' };
  return { credited: false, state: 'not_eligible' }; // reversed by the owner: a replay cannot undo that
}

// ── Reading and correcting ─────────────────────────────────────────────────

const PAGE_MAX = 100;
const pageLimit = (value: unknown) => Math.min(Math.max(Math.floor(Number(value ?? 50)) || 50, 1), PAGE_MAX);
const STATUSES = ['pending', 'confirmed', 'expired', 'reversed'];

/** An attribution as shown: no referred person's identity, ever. */
function dto(r: Attribution, forOwner: boolean) {
  return {
    referral_id: r.id, status: r.status, captured_at: r.captured_at, expires_at: r.expires_at, activated_at: r.activated_at, confirmed_at: r.confirmed_at,
    ...(forOwner ? { promoter_id: r.promoter_id, reversal_kind: r.reversal_kind, reversal_reason: r.reversal_reason, reversed_at: r.reversed_at } : {}),
  };
}

function counts(rows: { status: AttributionStatus; n: number }[]) {
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return { pending: by.pending ?? 0, confirmed: by.confirmed ?? 0, expired: by.expired ?? 0, reversed: by.reversed ?? 0 };
}

export async function listForOwner(db: D1Database, appId: string, query: { status?: string | undefined; promoter_id?: string | undefined; limit?: unknown; before_id?: string | undefined }) {
  if (query.status !== undefined && !STATUSES.includes(query.status)) throw new HttpError('invalid status', 400);
  const limit = pageLimit(query.limit);
  const { results } = await db.prepare(
    `SELECT * FROM app_referral_attributions WHERE app_id = ?1 AND (?2 IS NULL OR status = ?2) AND (?5 IS NULL OR promoter_id = ?5)
       AND (?3 IS NULL OR (created_at, rowid) < (SELECT created_at, rowid FROM app_referral_attributions WHERE app_id = ?1 AND id = ?3))
     ORDER BY created_at DESC, rowid DESC LIMIT ?4`,
  ).bind(appId, query.status ?? null, query.before_id ?? null, limit, query.promoter_id ?? null).all<Attribution>();
  const tally = await db.prepare('SELECT status, COUNT(*) AS n FROM app_referral_attributions WHERE app_id = ? GROUP BY status').bind(appId).all<{ status: AttributionStatus; n: number }>();
  const list = results ?? [];
  return { referrals: list.map((r) => dto(r, true)), counts: counts(tally.results ?? []), next: list.length === limit ? { before_id: list[list.length - 1]!.id } : null };
}

/** A promoter's own referrals: their pending and confirmed totals, and their own rows. Never an invitee's identity or another promoter's data. */
export async function listOwn(db: D1Database, appId: string, userId: string, query: { limit?: unknown; before_id?: string | undefined }) {
  const promoter = await db.prepare('SELECT id, status FROM app_promoters WHERE app_id = ? AND user_id = ?').bind(appId, userId).first<{ id: string; status: string }>();
  if (!promoter) throw new HttpError('not found', 404);
  const limit = pageLimit(query.limit);
  const { results } = await db.prepare(
    `SELECT * FROM app_referral_attributions WHERE app_id = ?1 AND promoter_id = ?2 AND status <> 'expired'
       AND (?3 IS NULL OR (created_at, rowid) < (SELECT created_at, rowid FROM app_referral_attributions WHERE app_id = ?1 AND id = ?3))
     ORDER BY created_at DESC, rowid DESC LIMIT ?4`,
  ).bind(appId, promoter.id, query.before_id ?? null, limit).all<Attribution>();
  const tally = await db.prepare('SELECT status, COUNT(*) AS n FROM app_referral_attributions WHERE app_id = ? AND promoter_id = ? GROUP BY status').bind(appId, promoter.id).all<{ status: AttributionStatus; n: number }>();
  const list = results ?? [];
  const c = counts(tally.results ?? []);
  return { promoter_status: promoter.status, counts: { pending: c.pending, confirmed: c.confirmed }, referrals: list.map((r) => dto(r, false)), next: list.length === limit ? { before_id: list[list.length - 1]!.id } : null };
}

export async function listEvents(db: D1Database, appId: string, query: { attribution_id?: string | undefined; limit?: unknown; before_id?: string | undefined }) {
  const limit = pageLimit(query.limit);
  const { results } = await db.prepare(
    `SELECT id, attribution_id, promoter_id, actor_kind, action, from_status, to_status, reason, created_at FROM app_referral_events
      WHERE app_id = ?1 AND (?2 IS NULL OR attribution_id = ?2)
        AND (?3 IS NULL OR (created_at, rowid) < (SELECT created_at, rowid FROM app_referral_events WHERE app_id = ?1 AND id = ?3))
      ORDER BY created_at DESC, rowid DESC LIMIT ?4`,
  ).bind(appId, query.attribution_id ?? null, query.before_id ?? null, limit).all<{ id: string }>();
  const list = results ?? [];
  return { events: list, next: list.length === limit ? { before_id: list[list.length - 1]!.id } : null };
}

const KINDS = ['fraud_invalid', 'correction'];
const clip = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new HttpError('invalid reason', 400);
  return value.trim() || null;
};

/**
 * An owner voids a confirmed credit (`fraud_invalid`: it was not a real user; `correction`: it was recorded wrongly)
 * or restores a reversed one. Idempotent, audited, and never reassigns: the person stays attributed to the same
 * promoter, and a reversed person cannot be re-credited by claiming again.
 */
export async function correct(db: D1Database, appId: string, attributionId: string, action: 'reverse' | 'restore', input: { kind?: unknown; reason?: unknown }, actorId: string, now = Date.now()) {
  const reverse = action === 'reverse';
  if (reverse && !KINDS.includes(input.kind as string)) throw new HttpError("kind must be 'fraud_invalid' or 'correction'", 400);
  const reason = clip(input.reason);
  const from: AttributionStatus = reverse ? 'confirmed' : 'reversed', to: AttributionStatus = reverse ? 'reversed' : 'confirmed';
  const results = await db.batch([
    db.prepare(`UPDATE app_referral_attributions SET status = ?1, reversal_kind = ?2, reversal_reason = ?3, reversed_at = ?4, updated_at = ?8
        WHERE id = ?5 AND app_id = ?6 AND status = ?7`)
      .bind(to, reverse ? input.kind : null, reverse ? reason : null, reverse ? now : null, attributionId, appId, from, now),
    db.prepare(`INSERT INTO app_referral_events (id, app_id, attribution_id, promoter_id, actor_kind, action, from_status, to_status, reason, created_at)
        SELECT ?1, ?2, id, promoter_id, 'owner', ?3, ?4, ?5, ?6, ?7 FROM app_referral_attributions WHERE id = ?8 AND app_id = ?2 AND changes() > 0`)
      .bind(crypto.randomUUID(), appId, reverse ? `reversed:${input.kind}` : 'restored', from, to, reason, now, attributionId),
  ]);
  const row = await db.prepare('SELECT * FROM app_referral_attributions WHERE id = ? AND app_id = ?').bind(attributionId, appId).first<Attribution>();
  if (!row) throw new HttpError('not found', 404);
  if (!results[0]?.meta?.changes && row.status !== to) throw new HttpError('invalid_transition', 409);
  return dto(row, true);
}
