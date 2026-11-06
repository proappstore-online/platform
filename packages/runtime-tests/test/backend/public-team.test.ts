import { SELF, env as providedEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ENQUIRY_IP_LIMIT } from '../../../backend/src/routes/enquiries';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #542 on workerd and real D1: the public team projection, the member opt-in and its
// removal/rejoin/transfer clearing (migration 0128's triggers), and typed team_join enquiries
// with a real concurrent burst against the atomic rate limit.

const env = providedEnv as unknown as Env;
const STOREFRONT = 'https://proappstore.online';
const good = { name: 'Sam', email: 'sam@example.com', message: 'I would like to help.' };

const publicTeam = async (appId = 'shop') => SELF.fetch(`${BASE}/v1/storefront/apps/${appId}/team`);
const members = async () => ((await (await publicTeam()).json()) as { members: { display_name: string; label: string | null; is_creator: boolean }[] }).members;
const setProfile = async (uid: string, body: unknown) => SELF.fetch(`${BASE}/v1/apps/shop/team/public/me`, json('PUT', body, await session(uid)));
const join = (body: unknown, opts: { appId?: string; origin?: string; ip?: string } = {}) => SELF.fetch(`${BASE}/v1/storefront/apps/${opts.appId ?? 'shop'}/enquiries/team-join`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', Origin: opts.origin ?? STOREFRONT, 'CF-Connecting-IP': opts.ip ?? '203.0.113.7' },
});

beforeEach(async () => {
  mockNetwork();
  for (const t of ['app_team_public_profiles', 'app_enquiries', 'app_visibility', 'team_members']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetTables();
  for (const uid of ['gh:1', 'gh:2', 'gh:3']) await seedUser(uid);
  await seedApp('shop', 'gh:1'); await seedApp('other', 'gh:3');
  await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:1','owner',1),('shop','gh:2','developer',1)").run();
});

describe('public team projection on D1 (#542)', () => {
  it('lists only opted-in current members, with no identifier, and answers private and missing apps alike', async () => {
    await setProfile('gh:2', { display_name: 'Ada L.', label: 'Maintainer', visible: true });
    await setProfile('gh:1', { display_name: 'Founder', visible: true });
    const text = await (await publicTeam()).text();
    expect(JSON.parse(text)).toEqual({ members: [{ display_name: 'Founder', label: null, is_creator: true }, { display_name: 'Ada L.', label: 'Maintainer', is_creator: false }] });
    for (const leak of ['gh:', 'developer', 'owner']) expect(text).not.toContain(leak);

    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('shop','private','[]',1)").run();
    const priv = await publicTeam(), missing = await publicTeam('nope');
    expect([priv.status, await priv.text()]).toEqual([missing.status, await missing.text()]);
    expect(missing.status).toBe(404);
  });

  it('removal withdraws visibility, rejoining does not restore it, and a stranger cannot publish', async () => {
    await setProfile('gh:2', { display_name: 'Ada', visible: true });
    expect((await setProfile('gh:3', { display_name: 'Eve', visible: true })).status).toBe(403);
    expect(await members()).toHaveLength(1);
    await env.DB.prepare("DELETE FROM team_members WHERE app_id = 'shop' AND user_id = 'gh:2'").run();
    expect(await members()).toEqual([]);
    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:2','developer',2)").run();
    expect(await members()).toEqual([]);
    expect((await setProfile('gh:2', { display_name: 'Ada', visible: true })).status).toBe(200);
    expect(await members()).toHaveLength(1);
  });

  it('a publisher transfer clears the old and the new publisher', async () => {
    await setProfile('gh:1', { display_name: 'Founder', visible: true });
    await setProfile('gh:2', { display_name: 'Ada', visible: true });
    await env.DB.prepare("UPDATE apps SET creator_id = 'gh:2' WHERE id = 'shop'").run();
    expect(await members()).toEqual([]);
    await setProfile('gh:2', { display_name: 'Ada', visible: true });
    expect(await members()).toEqual([{ display_name: 'Ada', label: null, is_creator: true }]);
  });

  it('the owner moderates; a member cannot read the view or hide others', async () => {
    await setProfile('gh:2', { display_name: 'Ada', visible: true });
    expect((await SELF.fetch(`${BASE}/v1/apps/shop/team/public`, json('GET', undefined, await session('gh:2')))).status).toBe(403);
    const owner = await SELF.fetch(`${BASE}/v1/apps/shop/team/public`, json('GET', undefined, await session('gh:1')));
    expect(((await owner.json()) as { members: unknown[] }).members).toHaveLength(2);
    expect((await SELF.fetch(`${BASE}/v1/apps/shop/team/public/gh:2`, json('DELETE', undefined, await session('gh:2')))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/shop/team/public/gh:2`, json('DELETE', undefined, await session('gh:1')))).status).toBe(200);
    expect(await members()).toEqual([]);
  });
});

describe('team_join enquiries on D1 (#542)', () => {
  it('stores a typed enquiry the owner can filter and count, and creates no membership', async () => {
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM team_members').first<{ n: number }>())!.n;
    expect((await join(good)).status).toBe(201);
    expect((await join({ ...good, email: 'x@example.com' }, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await join(good, { appId: 'nope' })).status).toBe(404);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM team_members').first<{ n: number }>())!.n).toBe(before);
    const res = await SELF.fetch(`${BASE}/v1/apps/shop/enquiries?type=team_join`, json('GET', undefined, await session('gh:1')));
    expect(await res.json()).toMatchObject({
      enquiries: [{ type: 'team_join', email: 'sam@example.com' }],
      counts: { new: 1, total: 1 }, new_count: 1, new_general_count: 0, new_team_join_count: 1,
      next: null,
    });
    expect((await SELF.fetch(`${BASE}/v1/apps/shop/enquiries`, json('GET', undefined, await session('gh:3')))).status).toBe(403);
  });

  it('a real concurrent burst cannot exceed the limit or store one address twice', async () => {
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => join({ ...good, email: `p${i}@example.com` })));
    expect(burst.filter((r) => r.status === 201)).toHaveLength(ENQUIRY_IP_LIMIT);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(20 - ENQUIRY_IP_LIMIT);
    const same = await Promise.all(Array.from({ length: 10 }, () => join({ ...good, email: 'same@example.com' }, { ip: '198.51.100.20' })));
    expect(same.every((r) => r.status === 201)).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM app_enquiries WHERE email = 'same@example.com'").first<{ n: number }>())!.n).toBe(1);
  });

  it('keeps existing general enquiries general, and tied timestamps page without a skip or repeat', async () => {
    for (let i = 0; i < 6; i++) {
      await env.DB.prepare("INSERT INTO app_enquiries (id, app_id, name, email, message, status, ip_hash, created_at, type) VALUES (?, 'shop', 'n', 'e@example.com', 'm', 'new', 'h', 1700000000000, ?)")
        .bind(`00000000-0000-4000-8000-00000000000${i}`, i % 2 ? 'team_join' : 'general').run();
    }
    const token = await session('gh:1');
    const seen: string[] = []; let cursor = '';
    for (let guard = 0; guard < 10; guard++) {
      const page = (await (await SELF.fetch(`${BASE}/v1/apps/shop/enquiries?limit=2${cursor}`, json('GET', undefined, token))).json()) as { enquiries: { id: string; type: string }[]; next: { before_id: string } | null };
      seen.push(...page.enquiries.map((e) => e.id));
      if (!page.next) break;
      cursor = `&before_id=${page.next.before_id}`;
    }
    expect(seen).toEqual([5, 4, 3, 2, 1, 0].map((i) => `00000000-0000-4000-8000-00000000000${i}`));
    expect((await env.DB.prepare("SELECT type FROM app_enquiries WHERE id LIKE '%0000'").first<{ type: string }>())!.type).toBe('general');
  });
});

describe('own saved preferences on real D1 (#552)', () => {
  const own = async (uid: string, appId = 'shop') => {
    const { mintSession, credentialContext } = await import('@proappstore/build-core');
    const token = await mintSession({ uid, roles: ['user'], cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
    return SELF.fetch(`${BASE}/v1/apps/${appId}/team/public/me`, { headers: { Authorization: `Bearer ${token}` } });
  };
  it('reads publisher, member and promoter-only preferences without writes; enforces app and lifecycle eligibility', async () => {
    await env.DB.prepare("INSERT INTO app_promoters (id,app_id,user_id,code,status,consent_version,consented_at,created_at,updated_at) VALUES ('own-profile','shop','gh:3','ABCDEFGH','active',1,1,1,1)").run();
    for (const uid of ['gh:1', 'gh:2', 'gh:3']) {
      expect(await (await own(uid)).json()).toEqual({ appId: 'shop', profile: null });
      await setProfile(uid, { display_name: 'Chosen', visible: true, show_promotion: uid === 'gh:3' });
      const before = await env.DB.prepare('SELECT * FROM app_team_public_profiles ORDER BY user_id').all();
      const res = await own(uid);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toContain('no-store');
      expect(await res.json()).toEqual({ appId: 'shop', profile: { display_name: 'Chosen', label: null, visible: true, show_promotion: uid === 'gh:3', updated_at: expect.any(String) } });
      expect(await env.DB.prepare('SELECT * FROM app_team_public_profiles ORDER BY user_id').all()).toMatchObject({ results: before.results });
    }
    expect((await own('gh:2', 'other')).status).toBe(403);
    expect((await own('gh:2', 'missing')).status).toBe(403);
    await env.DB.prepare("DELETE FROM team_members WHERE app_id='shop' AND user_id='gh:2'").run();
    expect((await own('gh:2')).status).toBe(403);
    for (const status of ['suspended', 'withdrawn']) {
      await env.DB.prepare("UPDATE app_promoters SET status=? WHERE id='own-profile'").bind(status).run();
      expect((await own('gh:3')).status).toBe(403);
    }
  });
});
