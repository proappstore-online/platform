import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const original = 'alias-original-574';
const alias = 'alias-public-574';
const user = 'gh:alias-user-574';
beforeEach(async () => {
  mockNetwork(); await resetTables(); await seedUser(user); await seedApp(original, user);
  await env.DB.prepare("INSERT INTO app_custom_domains (app_id, domain, status, canonical, added_at) VALUES (?1, ?2, 'active', 1, 1)").bind(original, `${alias}.proappstore.online`).run();
});
afterEach(async () => {
  await env.DB.prepare('DELETE FROM app_custom_domains WHERE app_id = ?1').bind(original).run();
  await env.DB.prepare('DELETE FROM routes WHERE slug IN (?1, ?2)').bind(original, alias).run();
  await resetTables();
});

describe('canonical alias reservations on real D1 (#574)', () => {
  it('refuses ordinary and admin claims before quota, registry or external provisioning side effects', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM provision_attempts').first<{ n: number }>();
    for (const roles of [['user'], ['user', 'admin']]) {
      const token = await session(user, { roles });
      for (const [path, body] of [
        ['/v1/provision', { appId: alias, skipCompliance: true }],
        ['/v1/provision-operations', { appId: alias, intent: {}, bootstrapIntent: {} }],
      ] as const) {
        const response = await SELF.fetch(`${BASE}${path}`, json('POST', body, token));
        expect(response.status).toBe(409);
      }
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM provision_attempts').first()).toEqual(before);
    expect(await env.DB.prepare('SELECT id FROM apps WHERE id = ?').bind(alias).first()).toBeNull();
    expect(await env.DB.prepare('SELECT slug FROM routes WHERE slug = ?').bind(alias).first()).toBeNull();
    expect(await env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?').bind(original).first()).toEqual({ creator_id: user });
  });
  it('enforces the namespace in D1 itself for callers outside the API preflight', async () => {
    await expect(env.DB.prepare('INSERT INTO apps (id, creator_id, created_at) VALUES (?1, ?2, 1)').bind(alias, user).run()).rejects.toThrow('reserved');
    await expect(env.DB.prepare("INSERT OR REPLACE INTO routes (slug, zone, r2_prefix, store, created_at, updated_at) VALUES (?1, 'proappstore.online', 'test', 'pas', 1, 1)").bind(alias).run()).rejects.toThrow('reserved');
  });
});
