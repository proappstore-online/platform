import { describe, expect, it, vi } from 'vitest';
import { forwardToDO } from './index.js';

// Regression guard for the cross-tenant WebSocket disclosure: a raw upgrade
// request must NOT be able to smuggle its own X-Team-Role / X-User-Id /
// X-User-Token to the DO. Only the router's verified values may reach it.
describe('forwardToDO strips caller-supplied trust headers on raw (WS) upgrades', () => {
  const capture = () => {
    const seen: Request[] = [];
    const stub = { fetch: vi.fn((r: Request) => { seen.push(r); return Promise.resolve(new Response(null)); }) };
    return { stub: stub as unknown as DurableObjectStub, seen };
  };

  it('drops a spoofed X-Team-Role and sets the server-derived identity', async () => {
    const { stub, seen } = capture();
    const raw = new Request('https://do/ws', {
      headers: { Upgrade: 'websocket', 'X-Team-Role': 'owner', 'X-User-Id': 'gh:victim', 'X-User-Token': 'stolen' },
    });
    await forwardToDO(stub, '/ws', 'gh:attacker', { raw });

    const fwd = seen[0]!;
    expect(fwd.headers.get('X-User-Id')).toBe('gh:attacker'); // server-set, not the spoof
    expect(fwd.headers.get('X-Team-Role')).toBeNull();        // spoof stripped (no verified role passed)
    expect(fwd.headers.get('X-User-Token')).toBeNull();       // spoof stripped
  });

  it('forwards only the router-verified team role when one is supplied', async () => {
    const { stub, seen } = capture();
    const raw = new Request('https://do/ws', {
      headers: { Upgrade: 'websocket', 'X-Team-Role': 'owner' }, // attacker claim
    });
    await forwardToDO(stub, '/ws', 'gh:member', { raw, teamRole: 'developer' }); // router-verified

    expect(seen[0]!.headers.get('X-Team-Role')).toBe('developer'); // verified value wins
  });
});
