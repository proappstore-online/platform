import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, resetTables } from './helpers';

// #323 on workerd and real D1: wrong currentPassword guesses at
// credentials/change-password share the credentials/login lockout — an atomic
// claim per attempt in credential_login_attempts, keyed on the session's user id.

const EMAIL = 'carol@example.com';
const PASSWORD = 'correct-horse-battery-staple';
const MAX = 10; // lib/credential-rate-limit MAX_ATTEMPTS
const WINDOW_MS = 15 * 60 * 1000;

let token = '';
let uid = '';
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await env.DB.prepare('DELETE FROM credential_login_attempts').run();
  await env.DB.prepare("DELETE FROM users WHERE id LIKE 'cred:%'").run();
  expect((await SELF.fetch(`${BASE}/v1/auth/credentials/register`, { ...json('POST', { email: EMAIL, password: PASSWORD }), headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.50' } })).status).toBe(202);
  token = await login(PASSWORD).then(async (r) => ((await r.json()) as { token: string }).token);
  uid = (await env.DB.prepare('SELECT id FROM users WHERE credential_email = ?').bind(EMAIL).first<{ id: string }>())!.id;
});

const login = (password: string) => SELF.fetch(`${BASE}/v1/auth/credentials/login`, json('POST', { login: EMAIL, password }));
async function change(currentPassword: string, newPassword = 'a-brand-new-passphrase'): Promise<{ status: number; body: unknown }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/credentials/change-password`, json('POST', { currentPassword, newPassword }, token));
  return { status: res.status, body: await res.json().catch(() => null) };
}
const counter = () => env.DB.prepare('SELECT window_start, count FROM credential_login_attempts WHERE login = ?').bind(uid).first<{ window_start: number; count: number }>();

describe('change-password is rate-limited like credential login (#323)', () => {
  it('sequential wrong guesses lock the account after MAX attempts, without revealing the count', async () => {
    for (let i = 0; i < MAX; i++) expect((await change(`wrong-${i}`)).status).toBe(403);
    const locked = await change('wrong-again');
    expect(locked.status).toBe(429);
    expect(JSON.stringify(locked.body)).not.toMatch(/\d/); // no count, limit or retry time
  });

  it('a locked account cannot change its password even with the correct current password', async () => {
    for (let i = 0; i < MAX; i++) await change(`wrong-${i}`);
    expect((await change(PASSWORD)).status).toBe(429);
    expect((await login(PASSWORD)).status).toBe(200); // unchanged — and login's counter is separate
  });

  it('parallel wrong guesses cannot exceed MAX: at most MAX are checked, the rest are refused', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => change(`wrong-${i}`)));
    expect(results.filter((r) => r.status === 403)).toHaveLength(MAX);
    expect(results.filter((r) => r.status === 429)).toHaveLength(25 - MAX);
    expect((await change(PASSWORD)).status).toBe(429);
  });

  it('a successful change works, keeps the session, and resets the counter', async () => {
    for (let i = 0; i < MAX - 1; i++) await change(`wrong-${i}`);
    expect(await change(PASSWORD, 'a-brand-new-passphrase')).toEqual({ status: 200, body: { ok: true } });
    expect(await counter()).toBeNull();
    expect((await login(PASSWORD)).status).toBe(401);
    expect((await login('a-brand-new-passphrase')).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/auth/me`, json('GET', undefined, token))).status).toBe(200); // the existing session still works
    for (let i = 0; i < MAX; i++) expect((await change(`wrong-${i}`)).status).toBe(403); // a fresh budget
  });

  it('the lock lifts once the window expires, with a fresh count', async () => {
    for (let i = 0; i <= MAX; i++) await change(`wrong-${i}`);
    expect((await change(PASSWORD)).status).toBe(429);
    await env.DB.prepare('UPDATE credential_login_attempts SET window_start = window_start - ? WHERE login = ?').bind(WINDOW_MS, uid).run();
    expect((await change('still-wrong')).status).toBe(403);
    expect(await counter()).toMatchObject({ count: 1 });
    expect((await change(PASSWORD)).status).toBe(200);
  });
});
