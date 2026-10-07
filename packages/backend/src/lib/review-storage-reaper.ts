/**
 * Review-upload retention (#307). A review upload (`_review/`, #208) is meant to
 * be deleted by its uploader or a reviewer once the review is decided; this is
 * the safety net for the reviews nobody decides. Once a day the platform deletes
 * every `<app>/_review/u/<uid>/<path>` object older than the app's retention
 * (`app_storage_config.review_retention_days`, default 30 days).
 *
 * - Apps are found from the bucket's top-level prefixes, not the `apps` table,
 *   so the documents of a deleted app expire too.
 * - Age is R2's own upload time (`uploaded`): set by the platform, always
 *   present, and the same instant as the `uploadedAt` metadata the upload route
 *   writes. Replacing a file restarts its clock.
 * - Every deletion is audited in `storage_review_access` (actor `system:retention`,
 *   action `platform_expired`) BEFORE the objects go, as reviewer deletes are: a
 *   failed audit write deletes nothing.
 * - A run is bounded; what it leaves is reported as backlog and taken next day.
 */
import type { Env } from '../types.js';

export const DEFAULT_REVIEW_RETENTION_DAYS = 30;
export const MAX_REVIEW_RETENTION_DAYS = 365;
export const REAPER_ACTOR = 'system:retention';
export const EXPIRED_ACTION = 'platform_expired';
/** Objects one run may delete: R2 lists and deletes and D1 batches are all subrequests. */
export const MAX_EXPIRED_PER_RUN = 2_000;
const DAY_MS = 86_400_000;
/** R2 deletes at most 1,000 keys per call. */
const DELETE_CHUNK = 1_000;
const REVIEW_KEY = /^[^/]+\/_review\/u\/([^/]+)\/(.+)$/;

export interface ReviewReapReport {
  /** App prefixes scanned. */
  apps: number;
  expired: number;
  /** True when the per-run bound stopped the run before every app was scanned. */
  backlog: boolean;
  errors: Record<string, string>;
}

/** The app's retention in days: a stored 1–365, otherwise the platform default. */
export function reviewRetentionDays(stored: unknown): number {
  return typeof stored === 'number' && Number.isInteger(stored) && stored >= 1 && stored <= MAX_REVIEW_RETENTION_DAYS
    ? stored
    : DEFAULT_REVIEW_RETENTION_DAYS;
}

/** Top-level prefixes of the bucket, without the trailing `/` — one per app. */
async function appPrefixes(bucket: R2Bucket): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ delimiter: '/', ...(cursor ? { cursor } : {}) });
    for (const p of page.delimitedPrefixes) out.push(p.slice(0, -1));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** Audit, then delete. The audit write comes first so no expiry goes unrecorded. */
async function expire(env: Pick<Env, 'DB' | 'STORAGE'>, appId: string, keys: string[], now: number): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
    const chunk = keys.slice(i, i + DELETE_CHUNK);
    await env.DB.batch(chunk.map((key) => {
      const [, ownerId, path] = REVIEW_KEY.exec(key)!;
      return env.DB.prepare(
        'INSERT INTO storage_review_access (app_id, owner_id, path, actor_id, action, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      ).bind(appId, ownerId, path, REAPER_ACTOR, EXPIRED_ACTION, now);
    }));
    await env.STORAGE.delete(chunk);
  }
}

export async function reapReviewUploads(env: Pick<Env, 'DB' | 'STORAGE'>, now = Date.now()): Promise<ReviewReapReport> {
  const report: ReviewReapReport = { apps: 0, expired: 0, backlog: false, errors: {} };
  const { results } = await env.DB.prepare(
    'SELECT app_id, review_retention_days FROM app_storage_config WHERE review_retention_days IS NOT NULL',
  ).all<{ app_id: string; review_retention_days: number }>();
  const retention = new Map((results ?? []).map((r) => [r.app_id, r.review_retention_days]));

  for (const appId of await appPrefixes(env.STORAGE)) {
    if (report.expired >= MAX_EXPIRED_PER_RUN) { report.backlog = true; break; }
    report.apps += 1;
    const cutoff = now - reviewRetentionDays(retention.get(appId)) * DAY_MS;
    try {
      // List first, delete after: deleting while paging could move the listing under its cursor.
      const room = MAX_EXPIRED_PER_RUN - report.expired;
      const due: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await env.STORAGE.list({ prefix: `${appId}/_review/u/`, ...(cursor ? { cursor } : {}) });
        for (const o of page.objects) if (o.uploaded.getTime() < cutoff && REVIEW_KEY.test(o.key)) due.push(o.key);
        cursor = page.truncated && due.length <= room ? page.cursor : undefined;
        if (page.truncated && !cursor) report.backlog = true;
      } while (cursor);
      if (due.length > room) report.backlog = true;
      const keys = due.slice(0, room);
      if (keys.length) {
        await expire(env, appId, keys, now);
        report.expired += keys.length;
      }
    } catch (e) {
      report.errors[appId] = String((e as Error)?.message ?? e).slice(0, 200);
      console.error(`[review-retention] ${appId}: ${report.errors[appId]}`);
    }
  }
  if (report.expired || report.backlog || Object.keys(report.errors).length) {
    console.log(`[review-retention] apps=${report.apps} expired=${report.expired} backlog=${report.backlog} errors=${Object.keys(report.errors).length}`);
  }
  return report;
}
