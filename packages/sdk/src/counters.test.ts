import { afterEach, describe, expect, it, vi } from 'vitest';
import { Counters } from './counters.js';
import type { Auth } from './auth.js';

// #259 review: a private app's counters are readable only by users it admits,
// so reads must carry the session when there is one.
function countersWith(isSignedIn: boolean) {
  const authenticatedFetch = vi.fn(async () => Response.json({ value: 3, total: 3 }));
  const auth = { isSignedIn, authenticatedFetch, handleUnauthorized: vi.fn() } as unknown as Auth;
  return { counters: new Counters('diary', 'https://api.proappstore.online', auth), authenticatedFetch };
}

afterEach(() => vi.unstubAllGlobals());

describe('Counters reads', () => {
  it('signed in: list and get go through authenticatedFetch (the session reaches a private app)', async () => {
    const plain = vi.fn();
    vi.stubGlobal('fetch', plain);
    const { counters, authenticatedFetch } = countersWith(true);
    await counters.list({ prefix: 'votes:' });
    expect(await counters.get('total')).toBe(3);
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(String((authenticatedFetch.mock.calls as unknown[][])[0]![0])).toBe('https://api.proappstore.online/v1/apps/diary/counters?prefix=votes%3A');
    expect(plain).not.toHaveBeenCalled();
  });

  it('signed out: anonymous fetch, as before (a public app)', async () => {
    const plain = vi.fn(async () => Response.json({ value: 7 }));
    vi.stubGlobal('fetch', plain);
    const { counters, authenticatedFetch } = countersWith(false);
    expect(await counters.get('total')).toBe(7);
    expect(plain).toHaveBeenCalledTimes(1);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
