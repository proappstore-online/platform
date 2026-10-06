/**
 * App-worker usage metering and daily quotas (#275, ADR-009 §4).
 *
 * One `app_worker_usage` row per app per UTC day, mirroring `app_log_usage`:
 *
 *   invocations      reserved atomically before every invoke — schedule, hook and
 *                    http alike (lib/app-worker-host.ts `invoke`, the one function
 *                    every type goes through). The reservation IS the quota gate.
 *   cpu_ms           wall-clock duration of each invocation. The loader returns no
 *                    CPU time, so this is a proxy and the usage route labels it.
 *   pas_calls        each invocation's own D1 counter (#254), added when it ends.
 *   hook_deliveries  accepted (verified, non-duplicate) deliveries (#256),
 *                    reserved by the hooks route before anything is delivered.
 *
 * Over quota throws {@link AppWorkerQuotaError}; each caller maps it (#275):
 * a schedule run fails with `quota exceeded` (counts toward the breaker), a hook
 * delivery is recorded `quota_exceeded` with a 202, an http request gets 429 with
 * Retry-After. A failed lookup is never an allow (#229/#230): it throws
 * `quota check unavailable` and no work starts.
 *
 * At 80 % of any quota: one `app_alerts` row and one `app.alert` webhook per app
 * per UTC day — the unique (app, kind, window) index makes it exactly-once.
 */
import type { Env } from '../types.js';
import { HttpError } from './auth.js';
import { secondsUntilUtcMidnight, utcDay } from './ai-budget.js';
import { dispatchWebhook } from './webhook-dispatch.js';

export interface AppWorkerQuotas { invocations: number; cpu_ms: number; hook_deliveries: number }
export type QuotaName = keyof AppWorkerQuotas;
const QUOTA_NAMES: QuotaName[] = ['invocations', 'cpu_ms', 'hook_deliveries'];

/**
 * Per app per UTC day. Provisional: #275 records the numbers measured on
 * duperdash (#262) before #267 opens app workers up. A `*\/5` schedule is 288
 * invocations a day; three of them, 864.
 */
export const DEFAULT_APP_WORKER_QUOTAS: AppWorkerQuotas = { invocations: 5_000, cpu_ms: 3_600_000, hook_deliveries: 2_000 };
export const QUOTA_ALERT_RATIO = 0.8;
/** How `cpu_ms` is measured. The loader reports no CPU time (ADR-009 §5). */
export const CPU_MS_SOURCE = 'wall';
export const QUOTA_ALERT_KIND = 'app_worker_quota';
export const ACCOUNT_CEILING_ALERT_KIND = 'app_worker_account_ceiling';
/** app_alerts.app_id of platform-wide alerts; `_` is never a legal app id. */
export const PLATFORM_ALERT_APP = '_platform';
const DAY_MS = 86_400_000;

export class AppWorkerQuotaError extends HttpError {
  readonly retryAfter: number;
  constructor(readonly quota: QuotaName, now: number) {
    super('quota exceeded', 429, { quota });
    this.retryAfter = secondsUntilUtcMidnight(now);
  }
}

export const quotaCheckUnavailable = () => new HttpError('quota check unavailable', 503);

/** The defaults, with an admin's per-app overrides (positive integers only) applied. */
export function quotasFrom(overrides: string | null | undefined): AppWorkerQuotas {
  const quotas = { ...DEFAULT_APP_WORKER_QUOTAS };
  if (!overrides) return quotas;
  try {
    const parsed = JSON.parse(overrides) as Record<string, unknown>;
    for (const name of QUOTA_NAMES) {
      const v = parsed[name];
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) quotas[name] = v;
    }
  } catch { /* a bad override is ignored, never an unlimited quota */ }
  return quotas;
}

/** Validate an admin's override body; null clears the overrides. */
export function validateQuotaOverrides(body: unknown): { error: string } | { overrides: Partial<AppWorkerQuotas> | null } {
  if (body === null) return { overrides: null };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object of quotas, or null' };
  const out: Partial<AppWorkerQuotas> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!QUOTA_NAMES.includes(k as QuotaName)) return { error: `unknown quota "${k}" (expected ${QUOTA_NAMES.join(', ')})` };
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return { error: `${k} must be a positive integer` };
    out[k as QuotaName] = v;
  }
  return { overrides: out };
}

interface UsageRow { invocations: number; cpu_ms: number; hook_deliveries: number; pas_calls: number }

/**
 * Reserve one invocation for today, or throw. One statement: the upsert only
 * counts while both `invocations` and `cpu_ms` are under quota, so concurrent
 * invokes cannot overshoot `invocations`.
 */
export async function reserveInvocation(env: Env, appId: string, quotas: AppWorkerQuotas, now: number): Promise<void> {
  let row: UsageRow | null;
  try {
    row = await env.DB.prepare(
      `INSERT INTO app_worker_usage (app_id, day, invocations) VALUES (?1, ?2, 1)
       ON CONFLICT(app_id, day) DO UPDATE SET invocations = invocations + 1
        WHERE invocations < ?3 AND cpu_ms < ?4
       RETURNING invocations, cpu_ms, hook_deliveries, pas_calls`,
    ).bind(appId, utcDay(now), quotas.invocations, quotas.cpu_ms).first<UsageRow>();
  } catch (e) {
    console.error(`[app-worker-usage] reserve failed for ${appId}: ${(e as Error)?.message ?? e}`);
    throw quotaCheckUnavailable();
  }
  if (!row) {
    const used = await todayUsage(env, appId, now).catch(() => null);
    throw new AppWorkerQuotaError(used && used.cpu_ms >= quotas.cpu_ms ? 'cpu_ms' : 'invocations', now);
  }
  await alertNearQuota(env, appId, row, quotas, now);
}

/** Reserve one hook delivery for today, or throw (as {@link reserveInvocation}). */
export async function reserveHookDelivery(env: Env, appId: string, quotas: AppWorkerQuotas, now: number): Promise<void> {
  let row: UsageRow | null;
  try {
    row = await env.DB.prepare(
      `INSERT INTO app_worker_usage (app_id, day, hook_deliveries) VALUES (?1, ?2, 1)
       ON CONFLICT(app_id, day) DO UPDATE SET hook_deliveries = hook_deliveries + 1 WHERE hook_deliveries < ?3
       RETURNING invocations, cpu_ms, hook_deliveries, pas_calls`,
    ).bind(appId, utcDay(now), quotas.hook_deliveries).first<UsageRow>();
  } catch (e) {
    console.error(`[app-worker-usage] hook reserve failed for ${appId}: ${(e as Error)?.message ?? e}`);
    throw quotaCheckUnavailable();
  }
  if (!row) throw new AppWorkerQuotaError('hook_deliveries', now);
  await alertNearQuota(env, appId, row, quotas, now);
}

/**
 * Add a finished invocation's duration and `PAS` call count to the day it was
 * reserved on. Never throws: metering must not fail an invocation that ran.
 */
export async function recordInvocationUsage(
  env: Env, appId: string, invocationId: string, quotas: AppWorkerQuotas, startedAt: number, finishedAt: number,
): Promise<void> {
  try {
    const row = await env.DB.prepare(
      `UPDATE app_worker_usage
          SET cpu_ms = cpu_ms + ?1,
              pas_calls = pas_calls + COALESCE((SELECT pas_calls FROM app_worker_invocations WHERE id = ?2), 0)
        WHERE app_id = ?3 AND day = ?4
       RETURNING invocations, cpu_ms, hook_deliveries, pas_calls`,
    ).bind(Math.max(0, finishedAt - startedAt), invocationId, appId, utcDay(startedAt)).first<UsageRow>();
    if (row) await alertNearQuota(env, appId, row, quotas, finishedAt);
  } catch (e) {
    console.error(`[app-worker-usage] recording ${invocationId} failed: ${(e as Error)?.message ?? e}`);
  }
}

async function todayUsage(env: Pick<Env, 'DB'>, appId: string, now: number): Promise<UsageRow | null> {
  return env.DB.prepare('SELECT invocations, cpu_ms, hook_deliveries, pas_calls FROM app_worker_usage WHERE app_id = ? AND day = ?')
    .bind(appId, utcDay(now)).first<UsageRow>();
}

/** The first quota at or past 80 % today, if any. */
export function nearQuota(usage: UsageRow, quotas: AppWorkerQuotas): QuotaName | null {
  return QUOTA_NAMES.find((q) => usage[q] >= Math.ceil(quotas[q] * QUOTA_ALERT_RATIO)) ?? null;
}

const dayStart = (now: number) => now - (now % DAY_MS);

/** Exactly one alert row and webhook per app per UTC day, whichever quota crosses 80 % first. */
async function alertNearQuota(env: Env, appId: string, usage: UsageRow, quotas: AppWorkerQuotas, now: number): Promise<void> {
  const quota = nearQuota(usage, quotas);
  if (!quota) return;
  try {
    const start = dayStart(now);
    const alert = await env.DB.prepare(
      'INSERT OR IGNORE INTO app_alerts (app_id, kind, window_start, window_end, count, affected_users, baseline, top, build_meta, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)',
    ).bind(
      appId, QUOTA_ALERT_KIND, start, start + DAY_MS, usage[quota], quotas[quota],
      JSON.stringify({ categories: [{ category: 'app_worker_quota', count: usage[quota] }], operations: [{ operation: quota, count: usage[quota] }], fingerprints: [] }),
      now,
    ).run();
    if (alert.meta?.changes) {
      await dispatchWebhook(env.DB, appId, 'app.alert', {
        event: 'app.alert', app_id: appId, kind: QUOTA_ALERT_KIND, quota, used: usage[quota], limit: quotas[quota], detected_at: now,
      });
    }
  } catch (e) {
    console.error(`[app-worker-usage] quota alert for ${appId} failed: ${(e as Error)?.message ?? e}`);
  }
}

/** Owner view: quotas, today's usage, and the last `days` days (newest first). */
export async function appWorkerUsage(env: Pick<Env, 'DB'>, appId: string, days: number, now: number) {
  const overrides = await env.DB.prepare('SELECT quota_overrides FROM app_workers WHERE app_id = ?').bind(appId).first<{ quota_overrides: string | null }>();
  const rows = await env.DB.prepare(
    'SELECT day, invocations, cpu_ms, hook_deliveries, pas_calls FROM app_worker_usage WHERE app_id = ? AND day >= ? ORDER BY day DESC',
  ).bind(appId, utcDay(now - (days - 1) * DAY_MS)).all<UsageRow & { day: string }>();
  const today = utcDay(now);
  const usage = rows.results ?? [];
  return {
    app_id: appId,
    quotas: quotasFrom(overrides?.quota_overrides),
    cpu_ms_source: CPU_MS_SOURCE,
    today: usage.find((r) => r.day === today) ?? { day: today, invocations: 0, cpu_ms: 0, hook_deliveries: 0, pas_calls: 0 },
    days: usage,
  };
}

// ── The account guard ───────────────────────────────────────────────────────

/** Whether new apps may be enabled (APP_WORKER_OPEN). A missing row reads as closed. */
export async function appWorkersOpen(env: Pick<Env, 'DB'>): Promise<boolean> {
  const row = await env.DB.prepare('SELECT open FROM app_worker_platform WHERE id = 1').first<{ open: number }>();
  return row?.open === 1;
}

export async function setAppWorkersOpen(env: Pick<Env, 'DB'>, open: boolean, reason: string | null, now: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT INTO app_worker_platform (id, open, closed_reason, closed_at) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET open = ?1, closed_reason = ?2, closed_at = ?3 WHERE open <> ?1`,
  ).bind(open ? 1 : 0, open ? null : reason, open ? null : now).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** `APP_WORKER_ACCOUNT_CEILING`: `{ cpu_ms, invocations }` per UTC day, summed over apps. */
export function parseAccountCeiling(raw: string | undefined): { cpu_ms: number; invocations: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { cpu_ms?: unknown; invocations?: unknown };
    if (typeof v.cpu_ms === 'number' && v.cpu_ms > 0 && typeof v.invocations === 'number' && v.invocations > 0) return { cpu_ms: v.cpu_ms, invocations: v.invocations };
  } catch { /* fall through */ }
  console.error('[app-worker-usage] APP_WORKER_ACCOUNT_CEILING is not { "cpu_ms": n, "invocations": n }; the account guard is off');
  return null;
}

/**
 * Today's account-wide app-worker usage against the ceiling. Above it, close
 * APP_WORKER_OPEN (new enables answer 409; running apps keep running) and alert
 * the platform admins once. It never reopens itself.
 */
export async function checkAccountCeiling(env: Env, now: number): Promise<{ closed: boolean }> {
  const ceiling = parseAccountCeiling(env.APP_WORKER_ACCOUNT_CEILING);
  if (!ceiling) return { closed: false };
  const sum = await env.DB.prepare('SELECT COALESCE(SUM(cpu_ms), 0) AS cpu_ms, COALESCE(SUM(invocations), 0) AS invocations FROM app_worker_usage WHERE day = ?')
    .bind(utcDay(now)).first<{ cpu_ms: number; invocations: number }>();
  const over = sum && (sum.cpu_ms > ceiling.cpu_ms || sum.invocations > ceiling.invocations);
  if (!over) return { closed: false };
  const reason = `account ceiling: today ${sum.invocations} invocations / ${sum.cpu_ms} cpu_ms over ${ceiling.invocations} / ${ceiling.cpu_ms}`;
  const changed = await env.DB.prepare(
    'UPDATE app_worker_platform SET open = 0, closed_reason = ?, closed_at = ? WHERE id = 1 AND open = 1',
  ).bind(reason, now).run();
  if (changed.meta?.changes) {
    const start = dayStart(now);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO app_alerts (app_id, kind, window_start, window_end, count, affected_users, baseline, top, build_meta, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)',
    ).bind(
      PLATFORM_ALERT_APP, ACCOUNT_CEILING_ALERT_KIND, start, start + DAY_MS, sum.invocations, ceiling.invocations,
      JSON.stringify({ categories: [{ category: 'app_worker_account', count: sum.invocations }], operations: [{ operation: 'cpu_ms', count: sum.cpu_ms }], fingerprints: [] }),
      now,
    ).run();
    console.error(`[app-worker-usage] APP_WORKER_OPEN closed — ${reason}`);
  }
  return { closed: true };
}
