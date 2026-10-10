import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
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
