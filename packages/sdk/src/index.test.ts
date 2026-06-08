import { describe, it, expect } from 'vitest';
import { initPro, ProAppStore } from './index.js';

describe('initPro', () => {
  it('returns a ProAppStore with all modules', () => {
    const app = initPro({ appId: 'demo' });
    expect(app).toBeInstanceOf(ProAppStore);
    expect(app.auth).toBeDefined();
    expect(app.kv).toBeDefined();
    expect(app.counters).toBeDefined();
    expect(app.rooms).toBeDefined();
    expect(app.roles).toBeDefined();
    expect(app.proxy).toBeDefined();
    expect(app.subscription).toBeDefined();
    expect(app.license).toBeDefined();
    expect(app.notifications).toBeDefined();
  });

  it('uses default API base when not specified', () => {
    const app = initPro({ appId: 'demo' });
    expect(app).toBeDefined();
  });

  it('accepts custom API base', () => {
    const app = initPro({ appId: 'demo', proApiBase: 'http://localhost:8788' });
    expect(app).toBeDefined();
  });
});
