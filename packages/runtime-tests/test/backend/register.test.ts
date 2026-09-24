import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, resetTables } from './helpers';

beforeEach(async () => { mockNetwork(); await resetTables(); await env.DB.prepare("DELETE FROM credential_login_attempts").run(); });

const REG = { email: 'Alice@Example.com', password: 'correct-horse-battery-staple', displayName: 'Alice' };
const post = (path: string, body: unknown, ip = '203.0.113.7') => ({ ...json('POST', body), headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip } });

// #118 on a real D1: the insert against the real users schema and the partial
// unique index on credential_email, the login that follows, and the per-IP
// limiter's rows in credential_login_attempts.
describe('credential self-registration against real D1', () => {
  it('registers, answers 202 without a session, and the account signs in by email as a plain user', async () => {
    const res = await SELF.fetch(`${BASE}/v1/auth/credentials/register`, post('', REG));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('set-cookie')).toBeNull();
    const row = await env.DB.prepare("SELECT id, provider, is_child, created_by, credential_email, credential_login, login FROM users WHERE credential_email = 'alice@example.com'").first<Record<string, unknown>>();
    expect(row).toMatchObject({ provider: 'credential', is_child: 0, created_by: null, credential_email: 'alice@example.com', login: 'Alice' });
    expect(String(row!.id)).toMatch(/^cred:/);
    const login = await SELF.fetch(`${BASE}/v1/auth/credentials/login`, json('POST', { login: 'alice@example.com', password: REG.password }));
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    const me = await SELF.fetch(`${BASE}/v1/auth/me`, json('GET', undefined, token));
    expect((await me.json()) as { roles: string[] }).toMatchObject({ roles: ['user'] });
  });

  it('a duplicate address is a 202 with a single row (partial unique index), and a policy miss is a 400 with no row', async () => {
    expect((await SELF.fetch(`${BASE}/v1/auth/credentials/register`, post('', REG))).status).toBe(202);
    const dup = await SELF.fetch(`${BASE}/v1/auth/credentials/register`, post('', { ...REG, password: 'a-different-long-passphrase' }));
    expect(dup.status).toBe(202);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE credential_email = 'alice@example.com'").first<{ n: number }>();
    expect(n?.n).toBe(1);
    expect((await SELF.fetch(`${BASE}/v1/auth/credentials/login`, json('POST', { login: 'alice@example.com', password: 'a-different-long-passphrase' }))).status).toBe(401);
    const weak = await SELF.fetch(`${BASE}/v1/auth/credentials/register`, post('', { email: 'bob@example.com', password: 'password1234' }));
    expect(weak.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE credential_email = 'bob@example.com'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('the per-address limiter counts every attempt in credential_login_attempts under its own key', async () => {
    for (let i = 0; i < 10; i++) expect((await SELF.fetch(`${BASE}/v1/auth/credentials/register`, post('', { email: `u${i}@example.com`, password: REG.password }))).status).toBe(202);
    expect((await SELF.fetch(`${BASE}/v1/auth/credentials/register`, post('', { email: 'u11@example.com', password: REG.password }))).status).toBe(429);
    const row = await env.DB.prepare("SELECT login, count FROM credential_login_attempts WHERE login = 'register-ip:203.0.113.7'").first<{ login: string; count: number }>();
    expect(row?.count).toBeGreaterThanOrEqual(10);
    expect((await SELF.fetch(`${BASE}/v1/auth/credentials/register`, post('', { email: 'u12@example.com', password: REG.password }, '198.51.100.9'))).status).toBe(202);
  });
});
