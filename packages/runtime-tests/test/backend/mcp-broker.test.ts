import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, json, mockNetwork, resetTables, seedUser, session } from './helpers';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function digest(value: string) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
async function hex(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, '0')).join(''); }
async function machineKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  return b64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey) as ArrayBuffer));
}
async function brokerApprovalCookie(requestId: string, token: string) {
  const body = b64(new TextEncoder().encode(JSON.stringify({ requestId, session: token, expiresAt: Date.now() + 60_000 })));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`pas:mcp:broker:approval:${body}`))));
  return `__Secure-pas_broker_approval=${body}.${signature}`;
}

beforeEach(async () => {
  mockNetwork(); await resetTables();
  await env.DB.prepare('DELETE FROM mcp_remote_auth_requests').run();
});

async function create() {
  await seedUser('gh:owner', 'owner');
  const proof = 'machine-proof-abcdefghijklmnopqrstuvwxyz0123456789';
  const verifier = 'code-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
  const response = await SELF.fetch(`${BASE}/v1/mcp/broker/v2/requests`, json('POST', {
    agent: { id: 'codex', label: 'Codex' }, machine: { id: 'mac-1', label: 'Remote Mac' },
    resource: 'https://mcp.test/mcp/apps/demo', scopes: [], code_challenge: await digest(verifier),
    machine_proof_hash: await hex(proof), machine_public_key: await machineKey(),
  }, await session('gh:owner', { login: 'owner' })));
  expect(response.status).toBe(201);
  return { ...(await response.json() as { request_id: string }), proof, verifier };
}

describe('remote MCP broker v2 on real D1 (#355)', () => {
  it('runs the synthetic browser-to-machine flow without a localhost callback or plaintext credential', async () => {
    const request = await create();
    const page = await SELF.fetch(`${BASE}/v1/mcp/broker/v2/requests/${request.request_id}/approve`);
    expect(await page.text()).toContain('Remote Mac');
    const token = await session('gh:owner', { login: 'owner' });
    const approved = await SELF.fetch(`${BASE}/v1/mcp/broker/v2/requests/${request.request_id}/approve`, {
      method: 'POST', headers: { Cookie: await brokerApprovalCookie(request.request_id, token) },
    });
    expect(approved.status).toBe(200);
    const redeemed = await SELF.fetch(`${BASE}/v1/mcp/broker/v2/requests/redeem`, json('POST', { request_id: request.request_id, machine_proof: request.proof, code_verifier: request.verifier, redeem_attempt_id: 'a'.repeat(43) }));
    expect(redeemed.status).toBe(200);
    const delivery = await redeemed.text();
    expect(delivery).toContain('ephemeral_public_key');
    expect(delivery).not.toContain('synthetic-resource-bound-token');
    const connected = await SELF.fetch(`${BASE}/v1/mcp/broker/v2/requests/connected`, json('POST', { request_id: request.request_id, machine_proof: request.proof, code_verifier: request.verifier }));
    expect(connected.status).toBe(200);
  });

  it('creates only canonical resource-bound, empty-effective-scope requests', async () => {
    const request = await create();
    expect(request.request_id).toMatch(/^req_[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare('SELECT resource, scopes, status FROM mcp_remote_auth_requests WHERE request_id = ?').bind(request.request_id).first<{ resource: string; scopes: string; status: string }>();
    expect(row).toEqual({ resource: 'https://mcp.test/mcp/apps/demo', scopes: '[]', status: 'pending' });
    const bad = await SELF.fetch(`${BASE}/v1/mcp/broker/v2/requests`, json('POST', {
      agent: { id: 'codex', label: 'Codex' }, machine: { id: 'mac', label: 'Mac' }, resource: 'https://mcp.test/mcp?scope=all', scopes: ['cosmetic'], code_challenge: await digest('x'.repeat(43)), machine_proof_hash: 'a'.repeat(64), machine_public_key: await machineKey(),
    }, await session('gh:owner')));
    expect(bad.status).toBe(400);
  });

  it('enforces polling cadence and does not disclose target metadata', async () => {
    const request = await create();
    const first = await SELF.fetch(`${BASE}/v1/mcp/broker/v2/requests/poll`, json('POST', { request_id: request.request_id, machine_proof: request.proof }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'pending', retry_after_ms: 2000 });
    const early = await SELF.fetch(`${BASE}/v1/mcp/broker/v2/requests/poll`, json('POST', { request_id: request.request_id, machine_proof: request.proof }));
    expect(early.status).toBe(429);
    expect(await early.text()).not.toContain('Remote Mac');
  });

  it('atomically consumes one encrypted result and allows only same-attempt retry', async () => {
    const request = await create();
    await env.DB.prepare("UPDATE mcp_remote_auth_requests SET status='approved_awaiting_machine', result_iv='iv', result_ciphertext=?, result_expires_at=? WHERE request_id=?")
      .bind(JSON.stringify({ ephemeral_public_key: 'ephemeral', ciphertext: 'sealed' }), Date.now() + 60_000, request.request_id).run();
    const redeem = (attempt: string) => SELF.fetch(`${BASE}/v1/mcp/broker/v2/requests/redeem`, json('POST', { request_id: request.request_id, machine_proof: request.proof, code_verifier: request.verifier, redeem_attempt_id: attempt }));
    const [a, b] = await Promise.all([redeem('a'.repeat(43)), redeem('b'.repeat(43))]);
    expect([a.status, b.status].filter((status) => status === 200)).toHaveLength(1);
    expect([a.status, b.status].filter((status) => status === 409)).toHaveLength(1);
    const winner = a.status === 200 ? 'a'.repeat(43) : 'b'.repeat(43);
    const winnerBody = await (a.status === 200 ? a : b).json();
    expect(winnerBody).toEqual(expect.objectContaining({ credential: expect.objectContaining({ ciphertext: 'sealed' }) }));
    const retry = await redeem(winner);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ credential: { ciphertext: 'sealed' } });
    expect(await env.DB.prepare('SELECT status FROM mcp_remote_auth_requests WHERE request_id=?').bind(request.request_id).first()).toEqual({ status: 'consumed' });
  });

  it('requires an MCP-worker receipt before connected and keeps the public status neutral', async () => {
    const request = await create();
    await env.DB.prepare("UPDATE mcp_remote_auth_requests SET status='consumed', result_expires_at=? WHERE request_id=?").bind(Date.now() + 60_000, request.request_id).run();
    const connected = await SELF.fetch(`${BASE}/v1/mcp/broker/v2/requests/connected`, json('POST', { request_id: request.request_id, machine_proof: request.proof, code_verifier: request.verifier }));
    expect(connected.status).toBe(200);
    const page = await SELF.fetch(`${BASE}/v1/mcp/broker/v2/requests/${request.request_id}/status`);
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(await page.text()).not.toContain('Remote Mac');
  });
});

describe('phone sign-in callback reasons (#356)', () => {
  const API = `${BASE}/v1/mcp/broker/v2/requests`;
  const codeCookie = (code: string) => `__Secure-pas_broker_login_code=${code}`;
  const callback = (id: string, cookie?: string) => SELF.fetch(`${API}/${id}/callback`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  let logs: string[];
  beforeEach(() => { logs = []; vi.spyOn(console, 'info').mockImplementation((line: unknown) => { logs.push(String(line)); }); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('names a missing login code and offers sign-in again', async () => {
    const { request_id: id } = await create();
    const res = await callback(id);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Reason: login code missing');
    expect(html).toContain('Status: pending');
    expect(html).toContain(`/requests/${id}/approve`);
  });

  it('names a spent or unknown login code', async () => {
    const { request_id: id } = await create();
    const res = await callback(id, codeCookie('d'.repeat(64)));
    expect(await res.text()).toContain('Reason: login code invalid');
  });

  it('names a wrong-owner sign-in without revealing either account', async () => {
    const { request_id: id } = await create();
    await seedUser('gh:intruder', 'intruder');
    const res = await callback(id, await mismatchedCookie('gh:intruder'));
    const html = await res.text();
    expect(html).toContain('Reason: owner mismatch');
    expect(html).not.toContain('intruder');
    expect(html).not.toContain('gh:owner');
    expect(await env.DB.prepare('SELECT status FROM mcp_remote_auth_requests WHERE request_id=?').bind(id).first()).toEqual({ status: 'pending' });
  });

  it('shows the real state of a request that expired or finished', async () => {
    const { request_id: id } = await create();
    await env.DB.prepare("UPDATE mcp_remote_auth_requests SET status='expired' WHERE request_id=?").bind(id).run();
    expect(await (await callback(id, await mismatchedCookie('gh:owner'))).text()).toContain('Reason: expired');
    await env.DB.prepare("UPDATE mcp_remote_auth_requests SET status='denied' WHERE request_id=?").bind(id).run();
    const html = await (await callback(id, await mismatchedCookie('gh:owner'))).text();
    expect(html).toContain('Status: denied');
    expect(html).toContain('Reason: request not pending');
  });

  it('is idempotent on a repeat hit once the approval is held', async () => {
    const { request_id: id } = await create();
    const first = await callback(id, await mismatchedCookie('gh:owner'));
    expect(first.status).toBe(302);
    const approvalCookie = /__Secure-pas_broker_approval=[^;]+/.exec(first.headers.get('set-cookie')!)![0];
    const again = await callback(id, approvalCookie);
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toContain(`/requests/${id}/approve`);
  });

  it('renders an issuance failure as a status page, and keeps JSON for API clients', async () => {
    const a = await create();
    const cookie = await brokerApprovalCookie(a.request_id, await session('gh:owner', { login: 'owner' }));
    const res = await SELF.fetch(`${API}/${a.request_id}/approve`, { method: 'POST', headers: { Cookie: cookie, Accept: 'text/html' } });
    const html = await res.text();
    if (res.status === 409) {
      expect(html).toContain('Reason: issue failed');
      const b = await create();
      const api = await SELF.fetch(`${API}/${b.request_id}/approve`, { method: 'POST', headers: { Cookie: await brokerApprovalCookie(b.request_id, await session('gh:owner', { login: 'owner' })) } });
      expect(api.status === 409 ? (await api.json() as { error: string }).error : 'remote_auth_unavailable').toBe('remote_auth_unavailable');
    } else {
      expect(html).toContain('Status: approved awaiting machine');
    }
  });

  it('never logs cookies, codes, sessions, owners or machines', async () => {
    const { request_id: id } = await create();
    await callback(id);
    await callback(id, codeCookie('e'.repeat(64)));
    await callback(id, await mismatchedCookie('gh:owner'));
    expect(logs.length).toBeGreaterThanOrEqual(3);
    const all = logs.join('\n');
    for (const secret of ['e'.repeat(64), id, 'gh:owner', 'mac-1', 'Remote Mac', '__Secure-', 'eyJ']) expect(all).not.toContain(secret);
    for (const line of logs) expect(JSON.parse(line)).toMatchObject({ event: 'mcp_broker', request: id.slice(0, 8) });
  });
});

/** A login-code cookie backed by a real exchange-code row for `uid`, as the provider callback would store it. */
async function mismatchedCookie(uid: string) {
  const code = crypto.getRandomValues(new Uint8Array(32));
  const plain = [...code].map((b) => b.toString(16).padStart(2, '0')).join('');
  const hash = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain))));
  const claims = JSON.stringify({ uid, login: uid.replace(/^gh:/, ''), avatarUrl: null, roles: ['user', 'creator'] });
  await env.DB.prepare('INSERT INTO auth_exchange_codes (code_hash, claims, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(hash, claims, Date.now() + 60_000, Date.now()).run();
  return `__Secure-pas_broker_login_code=${plain}`;
}
