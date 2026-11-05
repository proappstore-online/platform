import { HttpError } from '../auth.js';
import { plainText } from '../public-team.js';
import { generateCode, normalizeCode } from './codes.js';

/**
 * App-scoped promoter enrollment (#549, epic #548). A promoter is an existing PAS user who enrolled
 * to help grow one app. This module owns the relationship and its lifecycle (active / suspended /
 * withdrawn). It grants nothing else: it never reads or writes users, team_members, app roles or
 * apps, so enrolling cannot confer team, publisher, operator or admin rights. Attribution of the
 * users a promoter brings is #550; totals and the contributor projection are #551.
 */

const CONSENT_VERSION = 1;
const STOREFRONT_ORIGIN = 'https://proappstore.online';
const MAX_CODE_ATTEMPTS = 5;
const MAX_NAME = 60;
const MAX_REASON = 200;
const PAGE_MAX = 100;

export type PromoterStatus = 'active' | 'suspended' | 'withdrawn';

interface Row {
  id: string; app_id: string; user_id: string; code: string; status: PromoterStatus; display_name: string | null;
  consent_version: number; consented_at: number; status_reason: string | null; status_changed_by: string | null;
  status_changed_at: number | null; created_at: number; updated_at: number; app_public?: number;
}

const sharePath = (appId: string, code: string) => `/apps/${appId}?ref=${code}`;

/** What a promoter sees of their own relationship. No user id, and no other promoter's data. */
export function ownDto(r: Row) {
  return {
    promoter_id: r.id, app_id: r.app_id, status: r.status, code: r.code, code_active: r.status === 'active',
    display_name: r.display_name, share_path: sharePath(r.app_id, r.code), share_url: `${STOREFRONT_ORIGIN}${sharePath(r.app_id, r.code)}`,
    app_public: r.app_public === undefined ? undefined : r.app_public === 1,
    status_reason: r.status === 'suspended' ? r.status_reason : null,
    consented_at: r.consented_at, created_at: r.created_at, updated_at: r.updated_at,
  };
}

/** What the app owner sees: the canonical promoter id and what the person chose to show, never their user id or email. */
function ownerDto(r: Row) {
  return {
    promoter_id: r.id, status: r.status, code: r.code, display_name: r.display_name, status_reason: r.status_reason,
    status_changed_at: r.status_changed_at, created_at: r.created_at, updated_at: r.updated_at,
  };
}

// ── Eligibility ─────────────────────────────────────────────────────────────

/** Not private (a private or missing app is the same refusal), and the owner has not closed enrollment. */
const eligible = (n: number) => `EXISTS (SELECT 1 FROM apps a LEFT JOIN app_visibility v ON v.app_id = a.id LEFT JOIN app_promoter_settings s ON s.app_id = a.id
  WHERE a.id = ?${n} AND (v.mode IS NULL OR v.mode <> 'private') AND COALESCE(s.enrollment_open, 1) = 1)`;
const erased = (a: number, u: number) => `EXISTS (SELECT 1 FROM per_app_deleted_users d WHERE d.app_id = ?${a} AND d.user_id = ?${u})`;

async function assertCanEnroll(db: D1Database, appId: string, userId: string) {
  const app = await db.prepare(
    `SELECT COALESCE(s.enrollment_open, 1) AS open, (v.mode = 'private') AS is_private FROM apps a
       LEFT JOIN app_visibility v ON v.app_id = a.id LEFT JOIN app_promoter_settings s ON s.app_id = a.id WHERE a.id = ?`,
  ).bind(appId).first<{ open: number; is_private: number | null }>();
  if (!app || app.is_private) throw new HttpError('not found', 404);
  if (!app.open) throw new HttpError('enrollment_closed', 403);
  if (await db.prepare('SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?').bind(appId, userId).first()) throw new HttpError('account_deleted_in_app', 403);
}

const SELECT_OWN = `SELECT p.*, (v.mode IS NULL OR v.mode <> 'private') AS app_public FROM app_promoters p LEFT JOIN app_visibility v ON v.app_id = p.app_id`;

export async function ownRelationship(db: D1Database, appId: string, userId: string): Promise<Row | null> {
  return db.prepare(`${SELECT_OWN} WHERE p.app_id = ? AND p.user_id = ?`).bind(appId, userId).first<Row>();
}

export async function ownRelationships(db: D1Database, userId: string) {
  const { results } = await db.prepare(`${SELECT_OWN} WHERE p.user_id = ? ORDER BY p.created_at DESC, p.rowid DESC LIMIT ${PAGE_MAX}`).bind(userId).all<Row>();
  return (results ?? []).map(ownDto);
}

// ── Enrollment ──────────────────────────────────────────────────────────────

export interface EnrollInput { display_name: string | null; consent: true }

export function parseEnrollment(body: unknown): EnrollInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('JSON object required', 400);
  const b = body as Record<string, unknown>;
  // Explicit, per-enrollment consent to be a promoter for this app, with the name (if any) shown to the app.
  if (b.consent !== true) throw new HttpError('consent_required', 400);
  return { consent: true, display_name: plainText(b.display_name, 'display_name', MAX_NAME) };
}

/** Only a path on the caller's own site: relative, one leading slash, no scheme, host, backslash or control character. */
export function parseReturnPath(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 512 || !/^\/(?!\/)[^\\\x00-\x1f\x7f\s]*$/.test(value) || /^\/[a-z][a-z0-9+.-]*:/i.test(value)) throw new HttpError('invalid_return_path', 400);
  return value;
}

/**
 * Enroll `userId` for `appId`: idempotent and safe to repeat or race. A replay changes nothing and keeps what the
 * person already set. A withdrawn promoter re-enrolls. A **suspended** promoter is never reactivated here, however
 * often they sign in or enroll: only the owner lifts a suspension. The code is unique across apps in the
 * database; a collision (or a lost race) is retried with a fresh code.
 */
export async function enroll(db: D1Database, appId: string, userId: string, input: EnrollInput, now = Date.now(), code: () => string = generateCode) {
  await assertCanEnroll(db, appId, userId);
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const id = crypto.randomUUID();
    const results = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO app_promoters (id, app_id, user_id, code, status, display_name, consent_version, consented_at, created_at, updated_at)
          SELECT ?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, ?7, ?7 WHERE ${eligible(2)} AND NOT ${erased(2, 3)}`)
        .bind(id, appId, userId, code(), input.display_name, CONSENT_VERSION, now),
      db.prepare(`INSERT INTO app_promoter_events (id, app_id, promoter_id, actor_id, actor_kind, action, from_status, to_status, reason, created_at)
          SELECT ?1, ?2, ?3, ?4, 'self', 'enrolled', NULL, 'active', NULL, ?5 WHERE changes() > 0`)
        .bind(crypto.randomUUID(), appId, id, userId, now),
      db.prepare(`UPDATE app_promoters SET status = 'active', display_name = ?3, consent_version = ?4, consented_at = ?5, status_reason = NULL,
            status_changed_by = ?2, status_changed_at = ?5, updated_at = ?5
          WHERE app_id = ?1 AND user_id = ?2 AND status = 'withdrawn' AND ${eligible(1)} AND NOT ${erased(1, 2)}`)
        .bind(appId, userId, input.display_name, CONSENT_VERSION, now),
      db.prepare(`INSERT INTO app_promoter_events (id, app_id, promoter_id, actor_id, actor_kind, action, from_status, to_status, reason, created_at)
          SELECT ?1, ?2, (SELECT id FROM app_promoters WHERE app_id = ?2 AND user_id = ?3), ?3, 'self', 're_enrolled', 'withdrawn', 'active', NULL, ?4 WHERE changes() > 0`)
        .bind(crypto.randomUUID(), appId, userId, now),
    ]);
    const row = await ownRelationship(db, appId, userId);
    if (row) return { promoter: row, created: !!results[0]?.meta?.changes, reactivated: !!results[2]?.meta?.changes };
    // No row: a code collision, or the app stopped being eligible while we ran. Re-check, then retry with a new code.
    await assertCanEnroll(db, appId, userId);
  }
  throw new HttpError('could_not_allocate_code', 503);
}

/** The promoter leaves. Only an active promoter can; a suspended one stays suspended (leaving must not lift an owner's decision). */
export async function withdraw(db: D1Database, appId: string, userId: string, now = Date.now()) {
  const results = await db.batch([
    db.prepare(`UPDATE app_promoters SET status = 'withdrawn', display_name = NULL, status_reason = NULL, status_changed_by = ?2, status_changed_at = ?3, updated_at = ?3
        WHERE app_id = ?1 AND user_id = ?2 AND status = 'active'`).bind(appId, userId, now),
    db.prepare(`INSERT INTO app_promoter_events (id, app_id, promoter_id, actor_id, actor_kind, action, from_status, to_status, reason, created_at)
        SELECT ?1, ?2, (SELECT id FROM app_promoters WHERE app_id = ?2 AND user_id = ?3), ?3, 'self', 'withdrawn', 'active', 'withdrawn', NULL, ?4 WHERE changes() > 0`)
      .bind(crypto.randomUUID(), appId, userId, now),
  ]);
  const row = await ownRelationship(db, appId, userId);
  if (!row) throw new HttpError('not found', 404);
  if (!results[0]?.meta?.changes && row.status === 'suspended') throw new HttpError('suspended_by_owner', 409);
  return row;
}

export async function renameSelf(db: D1Database, appId: string, userId: string, value: unknown, now = Date.now()) {
  const display_name = plainText(value, 'display_name', MAX_NAME);
  const res = await db.prepare("UPDATE app_promoters SET display_name = ?3, updated_at = ?4 WHERE app_id = ?1 AND user_id = ?2 AND status = 'active'").bind(appId, userId, display_name, now).run();
  const row = await ownRelationship(db, appId, userId);
  if (!row) throw new HttpError('not found', 404);
  if (!res.meta?.changes) throw new HttpError('not_active', 409);
  return row;
}

// ── Owner lifecycle ─────────────────────────────────────────────────────────

const clip = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_REASON || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new HttpError('invalid reason', 400);
  return value.trim() || null;
};

/** Suspend an active promoter or lift a suspension. A withdrawn promoter cannot be changed: they must enroll again. */
export async function setStatus(db: D1Database, appId: string, promoterId: string, to: unknown, reasonInput: unknown, actorId: string, now = Date.now()) {
  if (to !== 'active' && to !== 'suspended') throw new HttpError("status must be 'active' or 'suspended'", 400);
  const reason = to === 'suspended' ? clip(reasonInput) : null;
  const from: PromoterStatus = to === 'suspended' ? 'active' : 'suspended';
  const results = await db.batch([
    db.prepare(`UPDATE app_promoters SET status = ?1, status_reason = ?2, status_changed_by = ?3, status_changed_at = ?4, updated_at = ?4
        WHERE id = ?5 AND app_id = ?6 AND status = ?7`).bind(to, reason, actorId, now, promoterId, appId, from),
    db.prepare(`INSERT INTO app_promoter_events (id, app_id, promoter_id, actor_id, actor_kind, action, from_status, to_status, reason, created_at)
        SELECT ?1, ?2, ?3, ?4, 'owner', ?5, ?6, ?7, ?8, ?9 WHERE changes() > 0`)
      .bind(crypto.randomUUID(), appId, promoterId, actorId, to === 'suspended' ? 'suspended' : 'reactivated', from, to, reason, now),
  ]);
  const row = await db.prepare('SELECT * FROM app_promoters WHERE id = ? AND app_id = ?').bind(promoterId, appId).first<Row>();
  if (!row) throw new HttpError('not found', 404);
  if (!results[0]?.meta?.changes && row.status !== to) throw new HttpError('invalid_transition', 409);
  return ownerDto(row);
}

function cursorPage<T extends { id: string }>(list: T[], limit: number) {
  return list.length === limit ? { before_id: list[list.length - 1]!.id } : null;
}
const pageLimit = (value: unknown) => Math.min(Math.max(Math.floor(Number(value ?? 50)) || 50, 1), PAGE_MAX);

export async function listForOwner(db: D1Database, appId: string, query: { status?: string | undefined; limit?: unknown; before_id?: string | undefined }) {
  if (query.status !== undefined && !['active', 'suspended', 'withdrawn'].includes(query.status)) throw new HttpError('invalid status', 400);
  const limit = pageLimit(query.limit);
  const { results } = await db.prepare(
    `SELECT * FROM app_promoters WHERE app_id = ?1 AND (?2 IS NULL OR status = ?2)
       AND (?3 IS NULL OR (created_at, rowid) < (SELECT created_at, rowid FROM app_promoters WHERE app_id = ?1 AND id = ?3))
     ORDER BY created_at DESC, rowid DESC LIMIT ?4`,
  ).bind(appId, query.status ?? null, query.before_id ?? null, limit).all<Row>();
  const counts = await db.prepare('SELECT status, COUNT(*) AS n FROM app_promoters WHERE app_id = ? GROUP BY status').bind(appId).all<{ status: PromoterStatus; n: number }>();
  const by = Object.fromEntries((counts.results ?? []).map((c) => [c.status, c.n]));
  const list = results ?? [];
  return {
    promoters: list.map(ownerDto),
    counts: { active: by.active ?? 0, suspended: by.suspended ?? 0, withdrawn: by.withdrawn ?? 0, total: (by.active ?? 0) + (by.suspended ?? 0) + (by.withdrawn ?? 0) },
    next: cursorPage(list, limit),
  };
}

export async function listEvents(db: D1Database, appId: string, query: { promoter_id?: string | undefined; limit?: unknown; before_id?: string | undefined }) {
  const limit = pageLimit(query.limit);
  const { results } = await db.prepare(
    `SELECT id, promoter_id, actor_kind, action, from_status, to_status, reason, created_at FROM app_promoter_events
      WHERE app_id = ?1 AND (?2 IS NULL OR promoter_id = ?2)
        AND (?3 IS NULL OR (created_at, rowid) < (SELECT created_at, rowid FROM app_promoter_events WHERE app_id = ?1 AND id = ?3))
      ORDER BY created_at DESC, rowid DESC LIMIT ?4`,
  ).bind(appId, query.promoter_id ?? null, query.before_id ?? null, limit).all<{ id: string }>();
  const list = results ?? [];
  return { events: list, next: cursorPage(list, limit) };
}

export async function getSettings(db: D1Database, appId: string) {
  const row = await db.prepare('SELECT enrollment_open FROM app_promoter_settings WHERE app_id = ?').bind(appId).first<{ enrollment_open: number }>();
  return { enrollment_open: row ? row.enrollment_open === 1 : true };
}

export async function putSettings(db: D1Database, appId: string, body: unknown, actorId: string, now = Date.now()) {
  const open = (body as { enrollment_open?: unknown } | null)?.enrollment_open;
  if (typeof open !== 'boolean') throw new HttpError('enrollment_open must be true or false', 400);
  await db.prepare(
    `INSERT INTO app_promoter_settings (app_id, enrollment_open, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(app_id) DO UPDATE SET enrollment_open = excluded.enrollment_open, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(appId, open ? 1 : 0, actorId, now).run();
  return { enrollment_open: open };
}

// ── Public ──────────────────────────────────────────────────────────────────

/** Public apps that take promoters, for the "pick an app" step. Only fields the storefront already publishes. */
export async function eligibleApps(db: D1Database, query: { after?: string | undefined; limit?: unknown }) {
  const limit = pageLimit(query.limit);
  const { results } = await db.prepare(
    `SELECT a.id AS app_id, l.icon_url, l.tagline, l.category FROM apps a
       LEFT JOIN app_listings l ON l.app_id = a.id LEFT JOIN app_visibility v ON v.app_id = a.id LEFT JOIN app_promoter_settings s ON s.app_id = a.id
      WHERE (v.mode IS NULL OR v.mode <> 'private') AND COALESCE(s.enrollment_open, 1) = 1 AND (?1 IS NULL OR a.id > ?1)
      ORDER BY a.id LIMIT ?2`,
  ).bind(query.after ?? null, limit).all<{ app_id: string; icon_url: string | null; tagline: string | null; category: string | null }>();
  const list = results ?? [];
  return {
    apps: list.map((r) => ({ appId: r.app_id, iconUrl: r.icon_url, tagline: r.tagline, category: r.category })),
    next: list.length === limit ? { after: list[list.length - 1]!.app_id } : null,
  };
}

/** Resolve a public code to its app and the display name the person chose. Anything that is not a live code of a public app is `null`, identically. */
export async function resolveCode(db: D1Database, input: unknown) {
  const code = normalizeCode(input);
  if (!code) return null;
  const row = await db.prepare(
    `SELECT p.app_id, p.display_name FROM app_promoters p
      WHERE p.code = ? AND p.status = 'active' AND NOT EXISTS (SELECT 1 FROM app_visibility v WHERE v.app_id = p.app_id AND v.mode = 'private')`,
  ).bind(code).first<{ app_id: string; display_name: string | null }>();
  return row ? { valid: true as const, app_id: row.app_id, promoter: { display_name: row.display_name } } : null;
}
