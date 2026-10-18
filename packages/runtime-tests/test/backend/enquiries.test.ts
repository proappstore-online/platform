import { SELF, env as providedEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ENQUIRY_APP_DAILY_LIMIT, ENQUIRY_HONEYPOT, ENQUIRY_IP_LIMIT } from '../../../backend/src/routes/enquiries';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #412 on real D1: the about- site's enquiry form stores per app, with spam
// protection and rate limits, and only the app's owner can read or update.

const env = providedEnv as unknown as Env;
const APP = 'shop';
const ORIGIN = `https://about-${APP}.proappstore.online`;
const good = { name: 'Ada', email: 'ada@example.com', message: 'Do you ship to Melbourne?' };

function postJson(body: unknown, opts: { appId?: string; origin?: string | null; ip?: string } = {}): Promise<Response> {
  const appId = opts.appId ?? APP;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': opts.ip ?? '203.0.113.7' };
  const origin = opts.origin === undefined ? `https://about-${appId}.proappstore.online` : opts.origin;
  if (origin) headers.Origin = origin;
  return SELF.fetch(`${BASE}/v1/apps/${appId}/enquiries`, { method: 'POST', headers, body: JSON.stringify(body) });
}
function postForm(fields: Record<string, string>, ip = '203.0.113.8'): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/apps/${APP}/enquiries`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, 'CF-Connecting-IP': ip },
    body: new URLSearchParams(fields).toString(),
  });
}
const stored = async (appId = APP) =>
  (await env.DB.prepare('SELECT name, email, message, status FROM app_enquiries WHERE app_id = ? ORDER BY created_at').bind(appId).all<Record<string, unknown>>()).results ?? [];

beforeEach(async () => {
  mockNetwork();
  await env.DB.prepare('DELETE FROM app_enquiries').run();
  await env.DB.prepare('DELETE FROM app_visibility').run();
  await resetTables();
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
  await seedUser('gh:2'); await seedApp('rival', 'gh:2');
});

describe('enquiries: public POST (#412)', () => {
  it('stores a JSON enquiry from the about- site, and a no-JS form post is answered with a 303 back to it', async () => {
    const res = await postJson(good);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, id: expect.any(String) });

    const form = await postForm({ ...good, name: 'Grace' });
    expect(form.status).toBe(303);
    expect(form.headers.get('Location')).toBe(`${ORIGIN}/?enquiry=sent#enquiry-sent`);
    expect(await stored()).toEqual([
      { ...good, status: 'new' },
      { ...good, name: 'Grace', status: 'new' },
    ]);
  });

  it('works for a private app', async () => {
    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES (?, 'private', '[]', 1)").bind(APP).run();
    expect((await postJson(good)).status).toBe(201);
    expect(await stored()).toHaveLength(1);
  });

  it('refuses another origin, no origin, an unknown app and invalid fields; stores nothing', async () => {
    expect((await postJson(good, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await postJson(good, { origin: 'https://about-rival.proappstore.online' })).status).toBe(403);
    expect((await postJson(good, { origin: null })).status).toBe(403);
    expect((await postJson(good, { appId: 'no-such-app' })).status).toBe(404);
    for (const bad of [
      { ...good, name: '' }, { ...good, email: 'not-an-email' }, { ...good, message: '   ' },
      { ...good, name: 'x'.repeat(101) }, { ...good, message: 'x'.repeat(5001) }, { name: 'only' },
    ]) {
      const res = await postJson(bad);
      expect(res.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    const form = await postForm({ ...good, email: 'nope' });
    expect(form.status).toBe(303);
    expect(form.headers.get('Location')).toBe(`${ORIGIN}/?enquiry=invalid#enquiry-invalid`);
    expect(await stored()).toEqual([]);
  });

  it('a filled honeypot looks like success and stores nothing', async () => {
    const res = await postJson({ ...good, [ENQUIRY_HONEYPOT]: 'https://spam.example' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });
    const form = await postForm({ ...good, [ENQUIRY_HONEYPOT]: 'x' });
    expect(form.headers.get('Location')).toBe(`${ORIGIN}/?enquiry=sent#enquiry-sent`);
    expect(await stored()).toEqual([]);
  });

  it('rate-limits per IP per app per hour, and per app per day', async () => {
    for (let i = 0; i < ENQUIRY_IP_LIMIT; i++) expect((await postJson(good)).status).toBe(201);
    const limited = await postJson(good);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('3600');
    expect((await postForm(good, '203.0.113.7')).headers.get('Location')).toBe(`${ORIGIN}/?enquiry=rate-limited#enquiry-rate-limited`);
    // Another IP, and the same IP at another app, are not limited by it.
    expect((await postJson(good, { ip: '198.51.100.1' })).status).toBe(201);
    expect((await postJson(good, { appId: 'rival' })).status).toBe(201);

    // The per-app daily ceiling holds across IPs.
    const now = Date.now();
    const fill = env.DB.prepare("INSERT INTO app_enquiries (id, app_id, name, email, message, status, ip_hash, created_at) VALUES (?, ?, 'n', 'e@x.io', 'm', 'new', ?, ?)");
    await env.DB.batch(Array.from({ length: ENQUIRY_APP_DAILY_LIMIT }, (_, i) => fill.bind(crypto.randomUUID(), APP, `filler-${i}`, now - 60_000)));
    expect((await postJson(good, { ip: '192.0.2.99' })).status).toBe(429);
  });
});

describe('enquiries: owner API (#412)', () => {
  it('the owner lists, reads and marks handled; others get 403, signed out 401', async () => {
    await postJson(good);
    await postJson({ ...good, name: 'Grace' }, { ip: '198.51.100.2' });
    await postJson({ ...good, name: 'Rival enquiry' }, { appId: 'rival' });
    const owner = await session('gh:1');

    const list = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/enquiries`, json('GET', undefined, owner))).json() as { enquiries: { id: string; name: string; status: string }[]; counts: { new: number; total: number } };
    expect(list.enquiries.map((e) => e.name)).toEqual(['Grace', 'Ada']);
    expect(list.counts).toEqual({ new: 2, total: 2 });
    expect(JSON.stringify(list)).not.toMatch(/ip_hash|Rival/);

    const id = list.enquiries[1]!.id;
    const one = await SELF.fetch(`${BASE}/v1/apps/${APP}/enquiries/${id}`, json('GET', undefined, owner));
    expect(await one.json()).toMatchObject({ id, ...good, status: 'new' });

    const handled = await SELF.fetch(`${BASE}/v1/apps/${APP}/enquiries/${id}`, json('PATCH', { status: 'handled' }, owner));
    expect(await handled.json()).toEqual({ id, status: 'handled' });
    const row = await env.DB.prepare('SELECT status, handled_by, handled_at FROM app_enquiries WHERE id = ?').bind(id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'handled', handled_by: 'gh:1' });
    expect(row!.handled_at).toEqual(expect.any(Number));
    const onlyNew = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/enquiries?status=new`, json('GET', undefined, owner))).json() as { enquiries: { name: string }[]; counts: { new: number } };
    expect(onlyNew.enquiries.map((e) => e.name)).toEqual(['Grace']);
    expect(onlyNew.counts.new).toBe(1);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/enquiries/${id}`, json('PATCH', { status: 'deleted' }, owner))).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/enquiries/${crypto.randomUUID()}`, json('GET', undefined, owner))).status).toBe(404);

    const other = await session('gh:2');
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/enquiries`, json('GET', undefined, other))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/enquiries/${id}`, json('GET', undefined, other))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/enquiries/${id}`, json('PATCH', { status: 'new' }, other))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/enquiries`, json('GET'))).status).toBe(401);
    // The rival app's owner cannot reach shop's enquiry through their own app either.
    expect((await SELF.fetch(`${BASE}/v1/apps/rival/enquiries/${id}`, json('GET', undefined, other))).status).toBe(404);
  });
});

describe('migration 0104_app_enquiries (#412)', () => {
  it('defaults to new, allows only new/handled, requires an app, indexes by app, and goes with its app', async () => {
    const insert = (id: string, appId: string, status?: string) => env.DB.prepare(
      `INSERT INTO app_enquiries (id, app_id, name, email, message, ${status ? 'status, ' : ''}ip_hash, created_at) VALUES (?, ?, 'n', 'e@x.io', 'm', ${status ? '?, ' : ''}'h', 1)`,
    ).bind(...[id, appId, ...(status ? [status] : [])]).run();
    await insert('a', APP);
    expect((await env.DB.prepare("SELECT status FROM app_enquiries WHERE id = 'a'").first<{ status: string }>())?.status).toBe('new');
    await expect(insert('b', APP, 'spam')).rejects.toThrow(/CHECK/);
    await expect(insert('c', 'no-such-app')).rejects.toThrow(/FOREIGN KEY/);
    const indexes = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'app_enquiries'").all<{ name: string }>();
    expect((indexes.results ?? []).map((r) => r.name)).toEqual(expect.arrayContaining(['idx_app_enquiries_app', 'idx_app_enquiries_rate']));
    await env.DB.prepare('DELETE FROM apps WHERE id = ?').bind(APP).run();
    expect(await stored()).toEqual([]);
  });
});
