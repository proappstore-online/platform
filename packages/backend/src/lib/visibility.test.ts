import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetAppVisibility, getAppVisibilityCached, isPlatformAdmin, VISIBILITY_CACHE_TTL_MS } from './visibility.js';

// #259 review: public storage, counter reads and room upgrades serve anonymous
// callers of PUBLIC apps, so the visibility read behind them is cached per
// isolate — and its failure mode is decided, not inherited from a D1 throw.
function dbAnswering(rows: Array<{ mode: string; roles: string } | null | Error>) {
  const first = vi.fn(async () => {
    const next = rows.length > 1 ? rows.shift()! : rows[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  return { db: { prepare: () => ({ bind: () => ({ first }) }) } as unknown as D1Database, first };
}

afterEach(() => {
  forgetAppVisibility();
  vi.useRealTimers();
});

describe('getAppVisibilityCached', () => {
  it('reads D1 once per app per TTL, then again after it', async () => {
    vi.useFakeTimers();
    const { db, first } = dbAnswering([null]);
    for (let i = 0; i < 5; i++) expect((await getAppVisibilityCached(db, 'open')).mode).toBe('public');
    expect(first).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(VISIBILITY_CACHE_TTL_MS + 1);
    await getAppVisibilityCached(db, 'open');
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('on a D1 error serves the last known mode — a public app keeps its images, a private one stays private', async () => {
    vi.useFakeTimers();
    const pub = dbAnswering([null, new Error('D1_ERROR: overloaded')]);
    await getAppVisibilityCached(pub.db, 'open');
    const priv = dbAnswering([{ mode: 'private', roles: '["viewer"]' }, new Error('D1_ERROR: overloaded')]);
    await getAppVisibilityCached(priv.db, 'diary');
    vi.advanceTimersByTime(VISIBILITY_CACHE_TTL_MS + 1);
    expect((await getAppVisibilityCached(pub.db, 'open')).mode).toBe('public');
    expect(await getAppVisibilityCached(priv.db, 'diary')).toEqual({ mode: 'private', roles: ['viewer'] });
  });

  it('on a D1 error with nothing known, refuses with 503 — never a guess', async () => {
    const { db } = dbAnswering([new Error('D1_ERROR: overloaded')]);
    await expect(getAppVisibilityCached(db, 'cold')).rejects.toMatchObject({ status: 503 });
  });

  it('forgetAppVisibility makes the next read live (a manifest was registered)', async () => {
    const { db, first } = dbAnswering([null, { mode: 'private', roles: '[]' }]);
    expect((await getAppVisibilityCached(db, 'flip')).mode).toBe('public');
    forgetAppVisibility('flip');
    expect((await getAppVisibilityCached(db, 'flip')).mode).toBe('private');
    expect(first).toHaveBeenCalledTimes(2);
  });
});

describe('isPlatformAdmin (#56: app-origin sessions carry only [user])', () => {
  it('recognises an admin by ADMIN_GITHUB_IDS as well as by the session role', () => {
    const env = { ADMIN_GITHUB_IDS: 'gh:9, gh:5' };
    expect(isPlatformAdmin(env, { id: 'gh:5', roles: ['user'] })).toBe(true);
    expect(isPlatformAdmin(env, { id: 'gh:1', roles: ['user', 'admin'] })).toBe(true);
    expect(isPlatformAdmin(env, { id: 'gh:1', roles: ['user'] })).toBe(false);
    expect(isPlatformAdmin({}, { id: 'gh:5', roles: ['user'] })).toBe(false);
  });
});
