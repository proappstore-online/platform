import { describe, it, expect } from 'vitest';
import { slidingWindowAllow } from './rate-limit.ts';

describe('slidingWindowAllow', () => {
  it('allows up to the limit, then blocks within the window', () => {
    let times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = slidingWindowAllow(times, 1000 + i, 3, 60_000);
      expect(r.allowed).toBe(true);
      times = r.times;
    }
    const blocked = slidingWindowAllow(times, 1100, 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.times).toHaveLength(3); // unchanged, not appended
  });

  it('prunes timestamps older than the window so capacity recovers', () => {
    const old = [0, 1, 2]; // far in the past
    const r = slidingWindowAllow(old, 1_000_000, 3, 60_000);
    expect(r.allowed).toBe(true);
    expect(r.times).toEqual([1_000_000]); // old ones dropped
  });

  it('treats the window boundary as exclusive (exactly windowMs old is pruned)', () => {
    const r = slidingWindowAllow([1000], 1000 + 60_000, 1, 60_000);
    expect(r.allowed).toBe(true);
  });
});
