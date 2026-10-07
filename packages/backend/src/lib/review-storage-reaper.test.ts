import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REVIEW_RETENTION_DAYS, EXPIRED_ACTION, MAX_EXPIRED_PER_RUN, REAPER_ACTOR, reapReviewUploads, reviewRetentionDays,
} from './review-storage-reaper.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 7, 3, 45);

/** An in-memory bucket: keys → upload time, with delimiter listing and 1,000-key pages. */
function bucket(objects: Record<string, number>) {
  const store = new Map(Object.entries(objects));
  const list = vi.fn(async (opts: { prefix?: string; delimiter?: string; cursor?: string }) => {
    const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
    if (opts.delimiter) {
      const prefixes = [...new Set(keys.map((k) => `${k.split('/')[0]}/`))];
      return { objects: [], delimitedPrefixes: prefixes, truncated: false };
    }
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const page = keys.slice(start, start + 1000);
    const truncated = start + 1000 < keys.length;
    return {
      objects: page.map((key) => ({ key, uploaded: new Date(store.get(key)!) })),
      delimitedPrefixes: [], truncated, ...(truncated ? { cursor: String(start + 1000) } : {}),
    };
  });
  const del = vi.fn(async (keys: string | string[]) => { for (const k of [keys].flat()) store.delete(k); });
  return { store, r2: { list, delete: del } as unknown as R2Bucket, del };
}

/** A D1 stand-in: the retention rows, and every audit batch (optionally failing). */
function db(retention: Record<string, number> = {}, opts: { auditFails?: boolean } = {}) {
  const audit: unknown[][] = [];
  const prepare = (sql: string) => ({
    sql,
    args: [] as unknown[],
    bind(...args: unknown[]) { this.args = args; return this; },
    async all() {
      return { results: Object.entries(retention).map(([app_id, review_retention_days]) => ({ app_id, review_retention_days })) };
    },
  });
  const batch = vi.fn(async (stmts: { sql: string; args: unknown[] }[]) => {
    if (opts.auditFails) throw new Error('D1 unavailable');
    for (const s of stmts) {
      expect(s.sql).toContain('INSERT INTO storage_review_access');
      audit.push(s.args);
    }
    return [];
  });
  return { audit, batch, d1: { prepare, batch } as unknown as D1Database };
}

describe('reviewRetentionDays (#307)', () => {
  it('uses a stored 1–365, otherwise the 30-day default', () => {
    expect(reviewRetentionDays(7)).toBe(7);
    expect(reviewRetentionDays(365)).toBe(365);
    for (const v of [null, undefined, 0, 366, 1.5, '7']) expect(reviewRetentionDays(v)).toBe(DEFAULT_REVIEW_RETENTION_DAYS);
  });
});

describe('reapReviewUploads (#307)', () => {
  it('deletes review uploads past the retention and audits each one before deleting', async () => {
    const { store, r2, del } = bucket({
      'stash/_review/u/gh:1/id.pdf': NOW - 31 * DAY,
      'stash/_review/u/gh:2/id.png': NOW - 29 * DAY, // inside the default window
      'stash/gh:1/private.txt': NOW - 400 * DAY, // not a review upload
      'stash/_public/u/gh:1/a.png': NOW - 400 * DAY,
    });
    const { audit, d1 } = db();
    const report = await reapReviewUploads({ STORAGE: r2, DB: d1 }, NOW);

    expect(report).toEqual({ apps: 1, expired: 1, backlog: false, errors: {} });
    expect([...store.keys()].sort()).toEqual(['stash/_public/u/gh:1/a.png', 'stash/_review/u/gh:2/id.png', 'stash/gh:1/private.txt']);
    expect(audit).toEqual([['stash', 'gh:1', 'id.pdf', REAPER_ACTOR, EXPIRED_ACTION, NOW]]);
    expect(del).toHaveBeenCalledWith(['stash/_review/u/gh:1/id.pdf']);
  });

  it("applies each app's own retention, and the default to apps without one (deleted apps included)", async () => {
    const { store, r2 } = bucket({
      'stash/_review/u/gh:1/a.pdf': NOW - 8 * DAY, // stash keeps 7 days
      'shop/_review/u/gh:1/b.pdf': NOW - 60 * DAY, // shop keeps 90 days
      'gone/_review/u/gh:1/c.pdf': NOW - 31 * DAY, // no config row: default 30
      'gone/_review/u/gh:1/d/e.pdf': NOW - 10 * DAY,
    });
    const report = await reapReviewUploads({ STORAGE: r2, DB: db({ stash: 7, shop: 90 }).d1 }, NOW);
    expect(report.expired).toBe(2);
    expect([...store.keys()].sort()).toEqual(['gone/_review/u/gh:1/d/e.pdf', 'shop/_review/u/gh:1/b.pdf']);
  });

  it('keeps an object exactly at the cutoff', async () => {
    const { store, r2 } = bucket({ 'stash/_review/u/gh:1/a.pdf': NOW - 30 * DAY });
    await reapReviewUploads({ STORAGE: r2, DB: db().d1 }, NOW);
    expect(store.size).toBe(1);
  });

  it('deletes nothing when the audit write fails, and reports the app', async () => {
    const { store, r2, del } = bucket({ 'stash/_review/u/gh:1/a.pdf': NOW - 31 * DAY });
    const report = await reapReviewUploads({ STORAGE: r2, DB: db({}, { auditFails: true }).d1 }, NOW);
    expect(del).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
    expect(report.errors).toEqual({ stash: 'D1 unavailable' });
  });

  it('pages through large prefixes and stops at the per-run bound, reporting a backlog', async () => {
    const objects: Record<string, number> = {};
    for (let i = 0; i < MAX_EXPIRED_PER_RUN + 500; i++) objects[`stash/_review/u/gh:1/f${String(i).padStart(5, '0')}.pdf`] = NOW - 40 * DAY;
    const { store, r2 } = bucket(objects);
    const { audit, d1 } = db();
    const report = await reapReviewUploads({ STORAGE: r2, DB: d1 }, NOW);
    expect(report.expired).toBe(MAX_EXPIRED_PER_RUN);
    expect(report.backlog).toBe(true);
    expect(audit).toHaveLength(MAX_EXPIRED_PER_RUN);
    expect(store.size).toBe(500);
  });
});
