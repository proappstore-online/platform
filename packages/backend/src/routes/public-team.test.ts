import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintSession } from '@proappstore/build-core';
import { app } from '../index.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv, testToken } from '../test-helpers.js';
import type { Env } from '../types.js';
import { aboutOrigin, ENQUIRY_IP_LIMIT } from './enquiries.js';

// #542 on real SQL (every migration applied, so the 0128 triggers and constraints are the real ones).
// Real workerd/D1 coverage of the same contract is in runtime-tests/test/backend/public-team.test.ts.

let db: ReturnType<typeof sqliteD1>;
let env: Env;
const OWNER = 'gh:1', ADA = 'gh:2', BOB = 'gh:3', STRANGER = 'gh:9';
const tokens: Record<string, string> = {};
const bearer = (uid: string) => ({ Authorization: `Bearer ${tokens[uid]}` });
const STOREFRONT = 'https://proappstore.online';

const req = (path: string, init: RequestInit = {}) => app.request(`/v1${path}`, init, env);
const put = (path: string, uid: string, body: unknown) => req(path, { method: 'PUT', headers: { ...bearer(uid), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const del = (path: string, uid: string) => req(path, { method: 'DELETE', headers: bearer(uid) });
const get = (path: string, uid?: string) => req(path, uid ? { headers: bearer(uid) } : {});
const profile = (uid: string, body: unknown, appId = 'shop') => put(`/apps/${appId}/team/public/me`, uid, body);
const publicTeam = async (appId = 'shop') => (await (await get(`/storefront/apps/${appId}/team`)).json()) as { members: { display_name: string; label: string | null; is_creator: boolean }[] };
const rows = (sql: string, ...args: unknown[]) => db.sql.prepare(sql).all(...(args as never[]));
const join = (appId: string, body: unknown, origin: string | null = STOREFRONT, ip = '203.0.113.7') => req(`/storefront/apps/${appId}/enquiries/team-join`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}) },
});
const good = { name: 'Sam', email: 'sam@example.com', message: 'I would like to help.' };

beforeEach(async () => {
  db = sqliteD1();
  db.sql.exec(`PRAGMA foreign_keys = ON;
    INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES
      ('gh:1','github','1','owner-login',0,0),('gh:2','github','2','ada-login',0,0),('gh:3','github','3','bob-login',0,0),('gh:9','github','9','stranger',0,0);
    INSERT INTO apps (id, creator_id, created_at) VALUES ('shop','gh:1',0),('other','gh:3',0);
    INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:1','owner',0),('shop','gh:2','developer',0),('other','gh:3','owner',0);`);
  env = makeEnv({ DB: db }) as Env;
  for (const uid of [OWNER, ADA, BOB, STRANGER]) tokens[uid] = await testToken(uid);
});
afterEach(() => vi.restoreAllMocks());

describe('public team projection (#542)', () => {
  it('a private or missing app is answered identically; a public app with nobody opted in is an empty list', async () => {
    db.sql.exec("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('other','private','[]',0)");
    const missing = await get('/storefront/apps/nope/team'), priv = await get('/storefront/apps/other/team');
    expect([priv.status, await priv.text(), priv.headers.get('Cache-Control')]).toEqual([missing.status, await missing.text(), missing.headers.get('Cache-Control')]);
    expect(missing.status).toBe(404);
    const open = await get('/storefront/apps/shop/team');
    expect(open.status).toBe(200);
    expect(open.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await open.json()).toEqual({ members: [] });
  });

  it('shows only what a current member opted in to publish, with no identifier, email, role or invitation', async () => {
    db.sql.exec("INSERT INTO team_invites (id, app_id, role, invited_by, email, token, expires_at, created_at) VALUES ('i1','shop','viewer','gh:1','pending@example.com','tok',9999999999999,0)");
    expect((await profile(ADA, { display_name: 'Ada L.', label: 'Maintainer', visible: true })).status).toBe(200);
    expect((await profile(OWNER, { display_name: 'Founder', visible: true })).status).toBe(200);
    const response = await get('/storefront/apps/shop/team');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ members: [
      { display_name: 'Founder', label: null, is_creator: true },
      { display_name: 'Ada L.', label: 'Maintainer', is_creator: false },
    ] });
    for (const secret of ['gh:', 'login', '@example', 'developer', 'owner', 'pending', 'invited', 'tok']) expect(text).not.toContain(secret);
  });

  it('nothing is public until the person opts in, and hidden profiles stay hidden', async () => {
    await profile(ADA, { display_name: 'Ada', visible: false });
    expect((await publicTeam()).members).toEqual([]);
    expect(rows('SELECT user_id, visible FROM app_team_public_profiles')).toEqual([{ user_id: ADA, visible: 0 }]);
  });

  it.each([
    ['markup', { display_name: '<b>Ada</b>', visible: true }],
    ['an entity', { display_name: 'Ada &amp; co', visible: true }],
    ['a link', { display_name: 'see https://evil.test', visible: true }],
    ['a bare domain', { display_name: 'ada.com', visible: true }],
    ['an email address', { display_name: 'ada@example.com', visible: true }],
    ['a control character', { display_name: 'Ada\u0007', visible: true }],
    ['too long a name', { display_name: 'x'.repeat(61), visible: true }],
    ['too long a label', { display_name: 'Ada', label: 'y'.repeat(41), visible: true }],
    ['a link in the label', { display_name: 'Ada', label: 'www.evil.test', visible: true }],
    ['no name while visible', { label: 'Maintainer', visible: true }],
    ['a non-boolean visible', { display_name: 'Ada', visible: 'yes' }],
    ['a non-string name', { display_name: 7, visible: true }],
  ])('refuses %s and stores nothing', async (_name, body) => {
    expect((await profile(ADA, body)).status).toBe(400);
    expect(rows('SELECT * FROM app_team_public_profiles')).toEqual([]);
  });

  it('accepts ordinary names with initials, apostrophes, hyphens and an ampersand', async () => {
    expect((await profile(ADA, { display_name: "J. R. O'Neil-Smith", label: 'UX & research', visible: true })).status).toBe(200);
    expect((await publicTeam()).members).toEqual([{ display_name: "J. R. O'Neil-Smith", label: 'UX & research', is_creator: false }]);
  });

  it('only a current member may publish; strangers, other apps, unauthenticated and person-less sessions cannot', async () => {
    expect((await profile(STRANGER, { display_name: 'Eve', visible: true })).status).toBe(403);
    expect((await profile(BOB, { display_name: 'Bob', visible: true })).status).toBe(403); // owns "other", not "shop"
    expect((await del('/apps/shop/team/public/me', STRANGER)).status).toBe(403);
    expect((await req('/apps/shop/team/public/me', { method: 'PUT', body: '{}' })).status).toBe(401);
    const machine = await mintSession({ uid: ADA, roles: ['user'], via: 'oidc-e2e' }, env.SESSION_SIGNING_KEY);
    const viaRes = await req('/apps/shop/team/public/me', { method: 'PUT', headers: { Authorization: `Bearer ${machine}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ display_name: 'Ada', visible: true }) });
    expect(viaRes.status).toBe(403);
    expect((await put('/apps/nope/team/public/me', ADA, { display_name: 'Ada', visible: true })).status).toBe(403);
    expect(rows('SELECT * FROM app_team_public_profiles')).toEqual([]);
  });

  it('a member of one app is not shown on another, and publishing on one app does not touch the other', async () => {
    await profile(ADA, { display_name: 'Ada', visible: true });
    await profile(BOB, { display_name: 'Bob', visible: true }, 'other');
    expect((await publicTeam('shop')).members.map((m) => m.display_name)).toEqual(['Ada']);
    expect((await publicTeam('other')).members.map((m) => m.display_name)).toEqual(['Bob']);
  });

  it('withdrawal hides the profile and keeps what the person wrote', async () => {
    await profile(ADA, { display_name: 'Ada', label: 'Maintainer', visible: true });
    const out = await del('/apps/shop/team/public/me', ADA);
    expect(await out.json()).toEqual({ ok: true, appId: 'shop', visible: false });
    expect((await publicTeam()).members).toEqual([]);
    expect(rows('SELECT display_name, visible FROM app_team_public_profiles')).toEqual([{ display_name: 'Ada', visible: 0 }]);
    await del('/apps/shop/team/public/me', ADA); // idempotent
  });

  it('removal withdraws visibility and rejoining does not restore it', async () => {
    await profile(ADA, { display_name: 'Ada', visible: true });
    expect((await del(`/apps/shop/team/${encodeURIComponent(ADA)}`, OWNER)).status).toBe(200); // the real removal route
    expect(rows("SELECT * FROM team_members WHERE app_id = 'shop' AND user_id = 'gh:2'")).toEqual([]);
    expect((await publicTeam()).members).toEqual([]);
    expect(rows('SELECT visible FROM app_team_public_profiles')).toEqual([{ visible: 0 }]);
    db.sql.exec("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:2','developer',1)");
    expect((await publicTeam()).members).toEqual([]);
    expect((await profile(ADA, { display_name: 'Ada', visible: true })).status).toBe(200);
    expect((await publicTeam()).members.map((m) => m.display_name)).toEqual(['Ada']);
  });

  it('a stale visible flag never shows someone who is no longer a member', async () => {
    db.sql.exec("INSERT INTO app_team_public_profiles (app_id, user_id, display_name, visible) VALUES ('shop','gh:9','Ghost',1)");
    expect((await publicTeam()).members).toEqual([]);
  });

  it('a publisher transfer clears both the old and the new publisher until they opt in again', async () => {
    await profile(OWNER, { display_name: 'Founder', visible: true });
    await profile(ADA, { display_name: 'Ada', visible: true });
    db.sql.exec("UPDATE apps SET creator_id = 'gh:2' WHERE id = 'shop'");
    expect((await publicTeam()).members).toEqual([]);
    expect(rows('SELECT user_id, visible FROM app_team_public_profiles ORDER BY user_id')).toEqual([{ user_id: OWNER, visible: 0 }, { user_id: ADA, visible: 0 }]);
    await profile(ADA, { display_name: 'Ada', visible: true });
    expect((await publicTeam()).members).toEqual([{ display_name: 'Ada', label: null, is_creator: true }]);
  });

  it('other apps are untouched by a removal or a transfer', async () => {
    await profile(BOB, { display_name: 'Bob', visible: true }, 'other');
    db.sql.exec("DELETE FROM team_members WHERE app_id = 'shop' AND user_id = 'gh:2'; UPDATE apps SET creator_id = 'gh:2' WHERE id = 'shop'");
    expect((await publicTeam('other')).members.map((m) => m.display_name)).toEqual(['Bob']);
  });

  it('delisting hides the list and relisting shows the members who still opted in', async () => {
    await profile(ADA, { display_name: 'Ada', visible: true });
    db.sql.exec("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('shop','private','[]',0)");
    expect((await get('/storefront/apps/shop/team')).status).toBe(404);
    db.sql.exec("UPDATE app_visibility SET mode = 'public' WHERE app_id = 'shop'");
    expect((await publicTeam()).members).toHaveLength(1);
  });

  it('owner moderation: only the owner sees the full view, and can take one person off the list', async () => {
    await profile(ADA, { display_name: 'Ada', label: 'Maintainer', visible: true });
    expect((await get('/apps/shop/team/public', ADA)).status).toBe(403);
    expect((await get('/apps/shop/team/public', BOB)).status).toBe(403);
    expect((await get('/apps/shop/team/public')).status).toBe(401);
    const view = await get('/apps/shop/team/public', OWNER);
    expect(view.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(await view.json()).toEqual({ appId: 'shop', members: [
      { user_id: OWNER, role: 'owner', display_name: null, label: null, visible: false, updated_at: null },
      { user_id: ADA, role: 'developer', display_name: 'Ada', label: 'Maintainer', visible: true, updated_at: expect.any(String) },
    ] });
    expect((await del(`/apps/shop/team/public/${ADA}`, ADA)).status).toBe(403);
    expect((await del(`/apps/other/team/public/${ADA}`, OWNER)).status).toBe(403); // not the owner of "other"
    expect((await del(`/apps/shop/team/public/${ADA}`, OWNER)).status).toBe(200);
    expect((await publicTeam()).members).toEqual([]);
    expect((await del(`/apps/shop/team/public/${ADA}`, OWNER)).status).toBe(404);
  });
});

describe('team_join enquiries (#542)', () => {
  const inbox = async (query = '', appId = 'shop', uid = OWNER) => (await (await get(`/apps/${appId}/enquiries${query}`, uid)).json()) as {
    enquiries: { id: string; type: string; email: string; status: string }[]; counts: Record<string, number>;
    new_count: number; new_general_count: number; new_team_join_count: number; next: { before_id: string } | null;
  };

  it('stores a typed enquiry in the owner inbox and grants no membership, invitation or email', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const members = rows('SELECT * FROM team_members'), invites = rows('SELECT * FROM team_invites');
    const response = await join('shop', good);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, id: expect.any(String) });
    expect(rows('SELECT * FROM team_members')).toEqual(members);
    expect(rows('SELECT * FROM team_invites')).toEqual(invites);
    expect(rows('SELECT * FROM app_team_public_profiles')).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    const list = await inbox();
    expect(list.enquiries).toMatchObject([{ type: 'team_join', email: 'sam@example.com', status: 'new' }]);
    expect(list).toMatchObject({ counts: { new: 1, total: 1 }, new_count: 1, new_general_count: 0, new_team_join_count: 1 });
    vi.unstubAllGlobals();
  });

  it('accepts exactly the app\'s about- site and the storefront; the contact endpoint keeps its stricter check', async () => {
    expect((await join('shop', { ...good, email: 'a@example.com' }, aboutOrigin('shop'))).status).toBe(201);
    expect((await join('shop', { ...good, email: 'b@example.com' }, STOREFRONT)).status).toBe(201);
    for (const origin of [null, 'https://evil.test', aboutOrigin('other'), 'https://www.proappstore.online', 'http://proappstore.online', 'https://about-shop.proappstore.online.evil.test']) {
      expect((await join('shop', { ...good, email: 'c@example.com' }, origin)).status).toBe(403);
    }
    const contact = await req('/apps/shop/enquiries', { method: 'POST', body: JSON.stringify(good), headers: { 'Content-Type': 'application/json', Origin: STOREFRONT } });
    expect(contact.status).toBe(403);
    expect(rows("SELECT COUNT(*) AS n FROM app_enquiries").at(0)).toEqual({ n: 2 });
  });

  it('a private or missing app is answered identically, whatever the origin', async () => {
    db.sql.exec("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('other','private','[]',0)");
    const a = await join('other', good), b = await join('nope', good), c = await join('other', good, 'https://evil.test');
    expect([a.status, b.status, c.status]).toEqual([404, 404, 404]);
    expect([await a.text(), await b.text(), await c.text()]).toEqual(['not found', 'not found', 'not found']);
    expect(rows('SELECT * FROM app_enquiries')).toEqual([]);
  });

  it.each([
    ['html in the message', { ...good, message: 'hi <script>alert(1)</script>' }],
    ['html in the name', { ...good, name: '<img src=x onerror=alert(1)>' }],
    ['an angle bracket in the name', { ...good, name: 'a < b' }],
    ['a link in the name', { ...good, name: 'https://evil.test' }],
    ['a www link in the name', { ...good, name: 'www.evil.test' }],
    ['a control character', { ...good, message: 'hi\u0000there' }],
    ['a bad email', { ...good, email: 'not-an-email' }],
    ['a missing name', { email: good.email, message: good.message }],
    ['an over-long message', { ...good, message: 'x'.repeat(5001) }],
    ['a non-string field', { ...good, name: 5 }],
  ])('refuses %s and stores nothing', async (_name, body) => {
    expect((await join('shop', body)).status).toBe(400);
    expect(rows('SELECT * FROM app_enquiries')).toEqual([]);
  });

  it('refuses non-JSON, unreadable and oversized requests', async () => {
    const send = (init: RequestInit) => req('/storefront/apps/shop/enquiries/team-join', { method: 'POST', ...init, headers: { Origin: STOREFRONT, ...(init.headers as Record<string, string>) } });
    expect((await send({ body: 'name=a', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    expect((await send({ body: '{not json', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
    expect((await send({ body: '[]', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
    expect((await send({ body: JSON.stringify(good), headers: { 'Content-Type': 'application/json', 'Content-Length': '99999' } })).status).toBe(413);
    expect(rows('SELECT * FROM app_enquiries')).toEqual([]);
  });

  it('answers a filled honeypot like a success and stores nothing', async () => {
    const response = await join('shop', { ...good, website: 'http://spam.test' });
    expect([response.status, await response.json()]).toEqual([201, { ok: true }]);
    expect(rows('SELECT * FROM app_enquiries')).toEqual([]);
  });

  it('one open request per address: a repeat is answered like a success and stores nothing, until it is handled', async () => {
    const first = await (await join('shop', good)).json() as { id: string };
    const again = await join('shop', { ...good, email: 'SAM@Example.com', message: 'different words' });
    expect([again.status, await again.json()]).toEqual([201, { ok: true }]);
    expect(rows('SELECT * FROM app_enquiries')).toHaveLength(1);
    expect((await req(`/apps/shop/enquiries/${first.id}`, { method: 'PATCH', headers: { ...bearer(OWNER), 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'handled' }) })).status).toBe(200);
    expect(await (await join('shop', good)).json()).toMatchObject({ id: expect.any(String) });
    expect(rows('SELECT * FROM app_enquiries')).toHaveLength(2);
    expect(await (await join('other', good)).json()).toMatchObject({ id: expect.any(String) }); // another app is independent
  });

  it('applies the contact form\'s atomic rate limits, shared across both types', async () => {
    const contact = (email: string) => req('/apps/shop/enquiries', { method: 'POST', body: JSON.stringify({ ...good, email }), headers: { 'Content-Type': 'application/json', Origin: aboutOrigin('shop'), 'CF-Connecting-IP': '203.0.113.7' } });
    for (let i = 0; i < ENQUIRY_IP_LIMIT - 1; i++) expect((await contact(`g${i}@example.com`)).status).toBe(201);
    expect((await join('shop', { ...good, email: 'last@example.com' })).status).toBe(201);
    const blocked = await join('shop', { ...good, email: 'over@example.com' });
    expect([blocked.status, blocked.headers.get('Retry-After')]).toEqual([429, '3600']);
    expect((await contact('over2@example.com')).status).toBe(429);
    expect((await join('shop', { ...good, email: 'elsewhere@example.com' }, STOREFRONT, '198.51.100.9')).status).toBe(201);
    expect(rows('SELECT COUNT(*) AS n FROM app_enquiries').at(0)).toEqual({ n: ENQUIRY_IP_LIMIT + 1 });
  });

  it('a burst of simultaneous requests cannot exceed the per-client limit or store one address twice', async () => {
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => join('shop', { ...good, email: `p${i}@example.com` })));
    expect(burst.filter((r) => r.status === 201)).toHaveLength(ENQUIRY_IP_LIMIT);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(12 - ENQUIRY_IP_LIMIT);
    const same = await Promise.all(Array.from({ length: 4 }, () => join('shop', { ...good, email: 'same@example.com' }, STOREFRONT, '198.51.100.20')));
    expect(same.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(rows("SELECT COUNT(*) AS n FROM app_enquiries WHERE email = 'same@example.com'").at(0)).toEqual({ n: 1 });
  });

  it('filters by type, keeps counts for the whole inbox, validates the filter and keeps general enquiries as they were', async () => {
    await req('/apps/shop/enquiries', { method: 'POST', body: JSON.stringify(good), headers: { 'Content-Type': 'application/json', Origin: aboutOrigin('shop'), 'CF-Connecting-IP': '198.51.100.1' } });
    await join('shop', { ...good, email: 'joiner@example.com' });
    const all = await inbox(), general = await inbox('?type=general'), joins = await inbox('?type=team_join');
    expect(all.enquiries.map((e) => e.type).sort()).toEqual(['general', 'team_join']);
    expect(general.enquiries.map((e) => e.type)).toEqual(['general']);
    expect(joins.enquiries.map((e) => e.type)).toEqual(['team_join']);
    for (const list of [all, general, joins]) {
      expect(list.counts).toEqual({ new: 2, total: 2 });
      expect([list.new_count, list.new_general_count, list.new_team_join_count]).toEqual([2, 1, 1]);
    }
    expect((await get('/apps/shop/enquiries?type=applicant', OWNER)).status).toBe(400);
    const one = await (await get(`/apps/shop/enquiries/${joins.enquiries[0]!.id}`, OWNER)).json();
    expect(one).toMatchObject({ type: 'team_join' });
  });

  it('only the owner reads the inbox, and one app\'s enquiries never appear in another', async () => {
    await join('shop', good);
    await join('other', { ...good, email: 'o@example.com' });
    expect((await get('/apps/shop/enquiries', BOB)).status).toBe(403);
    expect((await get('/apps/shop/enquiries', ADA)).status).toBe(403);
    expect((await inbox('', 'other', BOB)).enquiries.map((e) => e.email)).toEqual(['o@example.com']);
    expect((await inbox()).enquiries.map((e) => e.email)).toEqual(['sam@example.com']);
  });

  it('pages stably through enquiries that tie on the same millisecond, with and without the type filter', async () => {
    const insert = db.sql.prepare("INSERT INTO app_enquiries (id, app_id, name, email, message, status, ip_hash, created_at, type) VALUES (?, 'shop', 'n', 'e@example.com', 'm', 'new', 'h', ?, ?)");
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      const id = `00000000-0000-4000-8000-00000000000${i}`;
      ids.push(id);
      insert.run(id, i < 8 ? 1_700_000_000_000 : 1_700_000_000_500, i % 3 === 0 ? 'team_join' : 'general');
    }
    const page = async (type?: string) => {
      const seen: string[] = []; let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const list = await inbox(`?limit=2${type ? `&type=${type}` : ''}${cursor ? `&before_id=${cursor}` : ''}`);
        seen.push(...list.enquiries.map((e) => e.id));
        if (!list.next) break;
        cursor = list.next.before_id;
      }
      return seen;
    };
    const everything = await page();
    expect(everything).toHaveLength(9);
    expect(new Set(everything).size).toBe(9);
    expect(everything[0]).toBe(ids[8]);
    expect(everything.slice(1)).toEqual(ids.slice(0, 8).reverse());
    const joins = await page('team_join'), general = await page('general');
    expect(joins).toEqual(ids.filter((_, i) => i % 3 === 0).reverse());
    expect(general).toEqual(ids.filter((_, i) => i % 3 !== 0).reverse());
  });

  it('keeps every earlier enquiry general, and the type constraint refuses anything else', () => {
    db.sql.exec("INSERT INTO app_enquiries (id, app_id, name, email, message, status, ip_hash, created_at) VALUES ('old','shop','n','e@example.com','m','new','h',1)");
    expect(rows("SELECT type FROM app_enquiries WHERE id = 'old'")).toEqual([{ type: 'general' }]);
    expect(() => db.sql.exec("INSERT INTO app_enquiries (id, app_id, name, email, message, status, ip_hash, created_at, type) VALUES ('x','shop','n','e','m','new','h',1,'invite')")).toThrow();
  });
});

describe('own saved preferences (#552)', () => {
  const own = (uid: string, appId = 'shop') => get(`/apps/${appId}/team/public/me`, uid);
  beforeEach(async () => {
    const { credentialContext } = await import('@proappstore/build-core');
    for (const uid of [OWNER, ADA, BOB, STRANGER]) tokens[uid] = await mintSession({ uid, roles: ['user'], cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
    db.sql.exec("INSERT INTO app_promoters (id,app_id,user_id,code,status,consent_version,consented_at,created_at,updated_at) VALUES ('p','shop','gh:3','ABCDEFGH','active',1,1,1,1)");
  });
  it.each([OWNER, ADA, BOB])('reads only %s saved fields without creating or changing a row', async uid => {
    expect(await (await own(uid)).json()).toEqual({ appId: 'shop', profile: null });
    expect(rows('SELECT * FROM app_team_public_profiles')).toEqual([]);
    await profile(uid, { display_name: 'Chosen name', label: 'Contributor', visible: true, show_promotion: uid === BOB });
    const before = rows('SELECT * FROM app_team_public_profiles');
    const response = await own(uid);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({ appId: 'shop', profile: { display_name: 'Chosen name', label: 'Contributor', visible: true, show_promotion: uid === BOB, updated_at: expect.any(String) } });
    expect(rows('SELECT * FROM app_team_public_profiles')).toEqual(before);
    await del('/apps/shop/team/public/me', uid);
    expect(await (await own(uid)).json()).toMatchObject({ profile: { display_name: 'Chosen name', visible: false, show_promotion: false } });
  });
  it('denies removed, suspended, withdrawn, wrong-app and unknown identities without disclosing another profile', async () => {
    await profile(ADA, { display_name: 'Private name', visible: false });
    expect(await (await own(OWNER)).json()).toEqual({ appId: 'shop', profile: null });
    db.sql.exec("DELETE FROM team_members WHERE app_id='shop' AND user_id='gh:2'");
    expect((await own(ADA)).status).toBe(403);
    for (const status of ['suspended', 'withdrawn']) {
      db.sql.prepare('UPDATE app_promoters SET status=? WHERE id=?').run(status, 'p');
      expect((await own(BOB)).status).toBe(403);
    }
    for (const appId of ['shop', 'other', 'missing']) {
      expect((await own(STRANGER, appId)).status).toBe(403);
    }
    expect((await get('/apps/shop/team/public/me')).status).toBe(401);
  });
  it('denies app-bound, workload and unspecified credentials even for the owner', async () => {
    const { credentialContext } = await import('@proappstore/build-core');
    for (const cred of [undefined, credentialContext('app_bound', 'shop'), credentialContext('workload')]) {
      tokens[OWNER] = await mintSession({ uid: OWNER, roles: ['user'], ...(cred ? { cred } : {}) }, env.SESSION_SIGNING_KEY);
      expect((await own(OWNER)).status).toBe(403);
    }
  });
});
