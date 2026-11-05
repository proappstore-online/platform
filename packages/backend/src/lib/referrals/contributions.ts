import { HttpError } from '../auth.js';

/**
 * Promoter contribution read models (#551, epic #548). Everything here is computed at read time from the
 * attribution ledger (#550), so a reversal or restore changes totals, shares and standings together, and the audit
 * trail stays where it was written.
 *
 * What is and is not measured:
 *  - A promoter's contribution is their CONFIRMED referrals: people the platform recorded activating the app. Enrolling,
 *    a code, a click or a pending capture is not a contribution.
 *  - The percentage is `this promoter's confirmed referrals / ALL promoters' confirmed referrals` for the same app and
 *    period. It is a share among promoters. It is never a share of all users, and it is never combined with any
 *    code (lines-of-code) figure: the Code contribution is reported separately and is reported by a separate endpoint (#547).
 *  - Organic users (activations with no referral) are a separate bucket, shown to the owner only.
 *  - Only people PAS recorded activating the app since attribution began are counted. Earlier users are not reconstructed.
 *  - The period is half-open, `from <= t < to`. Confirmed and reversed credits are placed by when they were confirmed;
 *    pending and expired ones by when they were captured.
 */

const CONTRIBUTIONS_VERSION = 1;
const NOT_AVAILABLE = 'Code contribution is not part of this response. It is reported separately, to the app team, by GET /v1/apps/:appId/contributions (#545 to #547). No line counts are estimated here, and promotion and code are never combined into one figure.';
const SHARE_BASIS = "This promoter's confirmed referrals divided by all promoters' confirmed referrals for this app in this period. It is not a share of all users.";
const COVERAGE_NOTE = 'Referral attribution is recorded from when it was introduced; users who joined earlier are not reconstructed or inferred.';
const MAX_RANKED = 5000;
const FAR = Number.MAX_SAFE_INTEGER;

interface Period { from: number | null; to: number | null }

/** `from` / `to` as an ISO date (`2026-11-01`, UTC midnight), an ISO date-time with a zone, or epoch milliseconds. */
export function parsePeriod(query: { from?: string | undefined; to?: string | undefined }): Period {
  const one = (value: string | undefined, name: string): number | null => {
    if (value === undefined || value === '') return null;
    if (/^\d{10,16}$/.test(value)) return Number(value);
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`)
      : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(parsed)) throw new HttpError(`${name} must be an ISO date, an ISO date-time with a zone, or epoch milliseconds`, 400);
    return parsed;
  };
  const from = one(query.from, 'from'), to = one(query.to, 'to');
  if (from !== null && to !== null && from >= to) throw new HttpError('from must be before to', 400);
  return { from, to };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const periodView = (p: Period, withRule = true) => ({ from: p.from, to: p.to, from_iso: iso(p.from), to_iso: iso(p.to), ...(withRule ? { rule: 'from <= time < to; confirmed and reversed credits by confirmed_at, pending and expired by captured_at' } : {}) });

/** Zero denominators are zero, never NaN. */
function share(numerator: number, denominator: number) {
  const ratio = denominator === 0 ? 0 : numerator / denominator;
  return { numerator, denominator, ratio: Math.round(ratio * 1e6) / 1e6, percent: Math.round(ratio * 1e4) / 1e2, basis: SHARE_BASIS };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

const IN_CONFIRMED = '(?2 IS NULL OR x.confirmed_at >= ?2) AND (?3 IS NULL OR x.confirmed_at < ?3)';
const IN_CAPTURED = '(?2 IS NULL OR x.captured_at >= ?2) AND (?3 IS NULL OR x.captured_at < ?3)';

interface Row { promoter_id: string; display_name: string | null; status: string; confirmed: number; reversed: number; pending: number; expired: number; first_confirmed_at: number | null; }
interface Ranked extends Row { rank: number | null; tied_on_count: boolean }

/** Every promoter of the app with their counts in the period, ranked: confirmed (high first), then earliest first confirmation, then id. */
async function ranked(db: D1Database, appId: string, period: Period): Promise<Ranked[]> {
  const { results } = await db.prepare(
    `SELECT p.id AS promoter_id, p.display_name, p.status,
        COALESCE(SUM(CASE WHEN x.status = 'confirmed' AND ${IN_CONFIRMED} THEN 1 ELSE 0 END), 0) AS confirmed,
        COALESCE(SUM(CASE WHEN x.status = 'reversed' AND ${IN_CONFIRMED} THEN 1 ELSE 0 END), 0) AS reversed,
        COALESCE(SUM(CASE WHEN x.status = 'pending' AND ${IN_CAPTURED} THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN x.status = 'expired' AND ${IN_CAPTURED} THEN 1 ELSE 0 END), 0) AS expired,
        MIN(CASE WHEN x.status = 'confirmed' AND ${IN_CONFIRMED} THEN x.confirmed_at END) AS first_confirmed_at
       FROM app_promoters p LEFT JOIN app_referral_attributions x ON x.app_id = p.app_id AND x.promoter_id = p.id
      WHERE p.app_id = ?1 GROUP BY p.id LIMIT ${MAX_RANKED}`,
  ).bind(appId, period.from, period.to).all<Row>();
  const rows = (results ?? []).map((r) => ({ ...r, confirmed: Number(r.confirmed), reversed: Number(r.reversed), pending: Number(r.pending), expired: Number(r.expired) }));
  rows.sort((a, b) => b.confirmed - a.confirmed || (a.first_confirmed_at ?? FAR) - (b.first_confirmed_at ?? FAR) || (a.promoter_id < b.promoter_id ? -1 : a.promoter_id > b.promoter_id ? 1 : 0));
  const perCount = new Map<number, number>();
  for (const r of rows) perCount.set(r.confirmed, (perCount.get(r.confirmed) ?? 0) + 1);
  let position = 0;
  return rows.map((r) => ({ ...r, rank: r.confirmed > 0 ? ++position : null, tied_on_count: r.confirmed > 0 && (perCount.get(r.confirmed) ?? 0) > 1 }));
}

/** All promoters' totals in the period, straight from the ledger so the denominator never depends on which promoters still exist. */
async function totals(db: D1Database, appId: string, period: Period) {
  const t = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN x.status = 'confirmed' AND ${IN_CONFIRMED} THEN 1 ELSE 0 END), 0) AS confirmed,
            COALESCE(SUM(CASE WHEN x.status = 'reversed' AND ${IN_CONFIRMED} THEN 1 ELSE 0 END), 0) AS reversed,
            COALESCE(SUM(CASE WHEN x.status = 'pending' AND ${IN_CAPTURED} THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN x.status = 'expired' AND ${IN_CAPTURED} THEN 1 ELSE 0 END), 0) AS expired
       FROM app_referral_attributions x WHERE x.app_id = ?1`,
  ).bind(appId, period.from, period.to).first<{ confirmed: number; reversed: number; pending: number; expired: number }>();
  return { confirmed: Number(t?.confirmed ?? 0), reversed: Number(t?.reversed ?? 0), pending: Number(t?.pending ?? 0), expired: Number(t?.expired ?? 0) };
}

/** When the platform began recording activations for this app, and the as-of time: what the numbers can and cannot claim. */
async function freshness(db: D1Database, appId: string, now: number) {
  const since = await db.prepare('SELECT MIN(first_activated_at) AS since FROM app_user_activations WHERE app_id = ?').bind(appId).first<{ since: number | null }>();
  return { as_of: now, referrals_recorded_since: since?.since ?? null, note: COVERAGE_NOTE };
}

const allTimeFirstConfirmed = async (db: D1Database, appId: string, promoterId: string) =>
  (await db.prepare("SELECT MIN(confirmed_at) AS at FROM app_referral_attributions WHERE app_id = ? AND promoter_id = ? AND status = 'confirmed'").bind(appId, promoterId).first<{ at: number | null }>())?.at ?? null;

const standingOf = (all: Ranked[], r: Ranked) => ({ rank: r.rank, ranked_promoters: all.filter((x) => x.rank !== null).length, tied_on_count: r.tied_on_count });

// ── A promoter's own view ───────────────────────────────────────────────────

/**
 * A promoter's own contribution: pending / confirmed / reversed / expired counts, their share among promoters, and
 * their standing (rank and how many are ranked, nothing about who). Shown whatever their status: a suspended or
 * withdrawn promoter still reads their own record, and their confirmed credits still count in everyone's denominators.
 */
export async function getContributionTotals(db: D1Database, appId: string, userId: string, period: Period, now = Date.now()) {
  const own = await db.prepare('SELECT id, status FROM app_promoters WHERE app_id = ? AND user_id = ?').bind(appId, userId).first<{ id: string; status: string }>();
  if (!own) throw new HttpError('not found', 404);
  const [all, total, fresh, first] = await Promise.all([ranked(db, appId, period), totals(db, appId, period), freshness(db, appId, now), allTimeFirstConfirmed(db, appId, own.id)]);
  const me = all.find((r) => r.promoter_id === own.id)!;
  return {
    version: CONTRIBUTIONS_VERSION, app_id: appId, period: periodView(period), freshness: fresh,
    contributions: {
      promotion: {
        type: 'promotion_marketing', label: 'Promotion / Marketing', promoter_status: own.status,
        recorded: first !== null, first_confirmed_at: first,
        counts: { pending: me.pending, confirmed: me.confirmed, reversed: me.reversed, expired: me.expired },
        share_of_referred_users: share(me.confirmed, total.confirmed),
        standing: standingOf(all, me),
      },
      code: { type: 'code', label: 'Code', available: false, reason: NOT_AVAILABLE },
    },
  };
}

/** This promoter's confirmed referrals / all promoters' confirmed referrals for the same app and period. */
export async function getShareAmongPromoters(db: D1Database, appId: string, userId: string, period: Period) {
  const own = await db.prepare('SELECT id FROM app_promoters WHERE app_id = ? AND user_id = ?').bind(appId, userId).first<{ id: string }>();
  if (!own) throw new HttpError('not found', 404);
  const [all, total] = await Promise.all([ranked(db, appId, period), totals(db, appId, period)]);
  return share(all.find((r) => r.promoter_id === own.id)?.confirmed ?? 0, total.confirmed);
}

// ── The app owner's view ────────────────────────────────────────────────────

/**
 * Owner standings: every promoter, ranked, with counts and share; totals; and the acquisition split between referred,
 * reversed and organic users. The caller must already have passed the owner gate. Promoters appear by the name they chose
 * and their opaque promoter id, never a user id, and no invitee is named.
 */
export async function getStandings(db: D1Database, appId: string, period: Period, page: { limit?: unknown; after_id?: string | undefined } = {}, now = Date.now()) {
  const limit = Math.min(Math.max(Math.floor(Number(page.limit ?? 50)) || 50, 1), 100);
  const [all, total, fresh, acq] = await Promise.all([ranked(db, appId, period), totals(db, appId, period), freshness(db, appId, now), acquisition(db, appId, period)]);
  const start = page.after_id === undefined ? 0 : all.findIndex((r) => r.promoter_id === page.after_id) + 1;
  if (page.after_id !== undefined && start === 0) throw new HttpError('after_id is not a promoter of this app', 400);
  const slice = all.slice(start, start + limit);
  return {
    version: CONTRIBUTIONS_VERSION, app_id: appId, period: periodView(period), freshness: fresh,
    totals: { confirmed: total.confirmed, pending: total.pending, reversed: total.reversed, expired: total.expired, promoters: all.length, ranked_promoters: all.filter((r) => r.rank !== null).length },
    acquisition: {
      activations_recorded: acq.activations, referred_confirmed: acq.referred, referred_reversed: acq.reversed, organic: acq.organic,
      note: 'organic = recorded activations in the period with no confirmed or reversed referral. Counted by activation time, so it can differ slightly from the confirmed total at a period edge.',
    },
    contributions: { code: { type: 'code', available: false, reason: NOT_AVAILABLE } },
    standings: slice.map((r) => ({
      rank: r.rank, tied_on_count: r.tied_on_count, promoter_id: r.promoter_id, display_name: r.display_name, status: r.status,
      counts: { pending: r.pending, confirmed: r.confirmed, reversed: r.reversed, expired: r.expired }, first_confirmed_at: r.first_confirmed_at,
      share_of_referred_users: share(r.confirmed, total.confirmed),
    })),
    next: start + limit < all.length && slice.length ? { after_id: slice[slice.length - 1]!.promoter_id } : null,
  };
}

/** Activations recorded in the period, split into referred (confirmed), reversed and organic (everything else). */
async function acquisition(db: D1Database, appId: string, period: Period) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS activations,
            COALESCE(SUM(CASE WHEN x.status = 'confirmed' THEN 1 ELSE 0 END), 0) AS referred,
            COALESCE(SUM(CASE WHEN x.status = 'reversed' THEN 1 ELSE 0 END), 0) AS reversed
       FROM app_user_activations a LEFT JOIN app_referral_attributions x ON x.app_id = a.app_id AND x.referred_user_id = a.user_id
      WHERE a.app_id = ?1 AND (?2 IS NULL OR a.first_activated_at >= ?2) AND (?3 IS NULL OR a.first_activated_at < ?3)`,
  ).bind(appId, period.from, period.to).first<{ activations: number; referred: number; reversed: number }>();
  const activations = Number(row?.activations ?? 0), referred = Number(row?.referred ?? 0), reversed = Number(row?.reversed ?? 0);
  return { activations, referred, reversed, organic: activations - referred - reversed };
}

// ── Public recognition (#541/#542) ──────────────────────────────────────────

/** A public app: it exists and is not private. A private and a missing app are the same answer. */
export async function isPublicApp(db: D1Database, appId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS ok WHERE ${PUBLIC_APP}`).bind(appId).first());
}

const PUBLIC_APP = "EXISTS (SELECT 1 FROM apps a WHERE a.id = ?1) AND NOT EXISTS (SELECT 1 FROM app_visibility v WHERE v.app_id = ?1 AND v.mode = 'private')";
/** An ACTIVE promoter who chose, themselves, to show a name AND their promotion contribution. Nothing else is public. */
const OPTED_IN = `FROM app_promoters p JOIN app_team_public_profiles pr ON pr.app_id = p.app_id AND pr.user_id = p.user_id
   WHERE p.app_id = ?1 AND p.status = 'active' AND pr.visible = 1 AND pr.show_promotion = 1 AND pr.display_name IS NOT NULL AND pr.display_name <> '' AND ${PUBLIC_APP}`;

async function cardFor(db: D1Database, appId: string, row: { id: string; display_name: string; label: string | null }, period: Period, all: Ranked[], total: { confirmed: number }) {
  const first = await allTimeFirstConfirmed(db, appId, row.id);
  if (first === null) return null; // no confirmed referral yet: nothing recorded to recognise
  const mine = all.find((r) => r.promoter_id === row.id);
  return {
    display_name: row.display_name, label: row.label,
    contributions: {
      promotion: { type: 'promotion_marketing', label: 'Promotion / Marketing', recorded: true, confirmed_referrals: mine?.confirmed ?? 0, share_of_referred_users: share(mine?.confirmed ?? 0, total.confirmed) },
      code: { type: 'code', available: false },
    },
  };
}

/**
 * One public contributor card, or null (an identical 404 for the caller) if the app is private or missing, the promoter does
 * not exist, is not active, did not opt in to showing their promotion, or has no confirmed referral. Contains the chosen
 * name and label, a confirmed count and a share among promoters. No user id, email, invitee, pending or reversed figure.
 */
export async function getPublicContributorCard(db: D1Database, appId: string, promoterId: string, period: Period) {
  const row = await db.prepare(`SELECT p.id, pr.display_name, pr.label ${OPTED_IN} AND p.id = ?2`).bind(appId, promoterId).first<{ id: string; display_name: string; label: string | null }>();
  if (!row) return null;
  const [all, total] = await Promise.all([ranked(db, appId, period), totals(db, appId, period)]);
  const card = await cardFor(db, appId, row, period, all, total);
  return card && { version: CONTRIBUTIONS_VERSION, app_id: appId, period: periodView(period, false), ...card };
}

/** The public contributor list: every opted-in active promoter with a recorded contribution, ordered like the standings. */
export async function getPublicContributors(db: D1Database, appId: string, period: Period) {
  const { results } = await db.prepare(`SELECT p.id, pr.display_name, pr.label ${OPTED_IN}`).bind(appId).all<{ id: string; display_name: string; label: string | null }>();
  const [all, total] = await Promise.all([ranked(db, appId, period), totals(db, appId, period)]);
  const order = new Map(all.map((r, i) => [r.promoter_id, i]));
  const cards = (await Promise.all((results ?? []).sort((a, b) => (order.get(a.id) ?? FAR) - (order.get(b.id) ?? FAR)).map((r) => cardFor(db, appId, r, period, all, total)))).filter((c) => c !== null);
  return { version: CONTRIBUTIONS_VERSION, app_id: appId, period: periodView(period, false), contributors: cards };
}
