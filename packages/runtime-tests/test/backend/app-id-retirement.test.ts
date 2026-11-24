import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, resetTables, seedUser, session } from './helpers';

// #686 Phase 1: migration 0152 retires `loopride` (renamed to rideshare by 0150).
const user = 'gh:retired-id-686';
beforeEach(async () => { mockNetwork(); await resetTables(); await seedUser(user); });
afterEach(async () => {
  await env.DB.prepare("DELETE FROM routes WHERE slug = 'loopride'").run();
  await resetTables();
});

describe('retired app IDs on real D1 (#686)', () => {
  it('refuses ordinary and admin claims of a retired ID before quota, registry or external side effects', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM provision_attempts').first<{ n: number }>();
    for (const roles of [['user'], ['user', 'admin']]) {
      const token = await session(user, { roles });
      for (const [path, body] of [
        ['/v1/provision', { appId: 'loopride', skipCompliance: true }],
        ['/v1/provision-operations', { appId: 'loopride', intent: {}, bootstrapIntent: {} }],
      ] as const) {
        const response = await SELF.fetch(`${BASE}${path}`, json('POST', body, token));
        expect(response.status).toBe(409);
        expect(await response.text()).toBe('app ID retired');
      }
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM provision_attempts').first()).toEqual(before);
    expect(await env.DB.prepare("SELECT id FROM apps WHERE id = 'loopride'").first()).toBeNull();
  });

  it('enforces retirement in D1 itself for writers outside the API preflight', async () => {
    await expect(env.DB.prepare("INSERT INTO apps (id, creator_id, created_at) VALUES ('loopride', ?1, 1)").bind(user).run()).rejects.toThrow('app ID retired');
    await expect(env.DB.prepare("INSERT OR REPLACE INTO routes (slug, zone, r2_prefix, store, created_at, updated_at) VALUES ('loopride', 'proappstore.online', 'apps/loopride', 'pas', 1, 1)").run()).rejects.toThrow('app ID retired');
  });
});
