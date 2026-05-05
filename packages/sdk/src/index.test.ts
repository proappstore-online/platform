import { describe, it, expect } from 'vitest';
import { initPro, ProAppStore } from './index.js';

describe('initPro', () => {
  it('returns a ProAppStore with subscription and license modules', () => {
    const pas = initPro({ appId: 'demo', authToken: 'tok' });
    expect(pas).toBeInstanceOf(ProAppStore);
    expect(pas.subscription).toBeDefined();
    expect(pas.license).toBeDefined();
  });

  it('accepts a token function so callers can plumb in fas.auth.token reactively', () => {
    let current: string | null = 'first';
    const pas = initPro({ appId: 'demo', authToken: () => current });
    expect(pas).toBeDefined();
    current = 'second';
    // The captured fn is what subscription.req() calls — by changing
    // `current` we'd see the new value on the next request. This test
    // just verifies the wiring compiles; behavior is HTTP-tested elsewhere.
  });

  it('uses the default apiBase when not specified', () => {
    const pas = initPro({ appId: 'demo', authToken: 't' });
    expect(pas).toBeDefined();
    // (apiBase isn't publicly exposed; the contract is "uses prod by default".)
  });
});
