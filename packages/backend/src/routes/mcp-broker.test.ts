import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken, TEST_SK } from '../test-helpers.js';
import { sha256Hex } from '../lib/app-tokens.js';

type Row = Record<string, unknown>;

function memoryDb() {
  const requests = new Map<string, Row>();
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...next: unknown[]) { args = next; return this; },
        async first<T>() {
          if (sql.includes('FROM mcp_remote_auth_requests')) return (requests.get(args[0] as string) ?? null) as T | null;
          if (sql.includes('FROM users')) return { login: 'owner', avatar_url: null } as T;
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO mcp_remote_auth_requests')) {
            const id = args[0] as string;
            if (requests.has(id)) throw new Error('unique');
            requests.set(id, {
              request_id: id, owner_id: args[1], agent_id: args[2], agent_label: args[3], machine_id: args[4], machine_label: args[5],
              resource: args[6], scopes: args[7], code_challenge: args[8], machine_proof_hash: args[9], status: 'pending', expires_at: args[10],
              result_iv: null, result_ciphertext: null,
            });
            return { meta: { changes: 1 } };
          }
          const id = args.includes('req_abcdefghijklmnopqrstuvwxyz012345') ? 'req_abcdefghijklmnopqrstuvwxyz012345' : args.find((a) => typeof a === 'string' && requests.has(a)) as string;
          const row = requests.get(id);
          if (!row) return { meta: { changes: 0 } };
          if (sql.includes("status = 'expired'")) {
            if (Number(row.expires_at) <= Number(args[2]) && ['pending', 'approved_awaiting_machine'].includes(row.status as string)) row.status = 'expired';
            return { meta: { changes: row.status === 'expired' ? 1 : 0 } };
          }
          if (sql.includes("status = 'connected'")) {
            if (row.status !== 'consumed') return { meta: { changes: 0 } };
            row.status = 'connected'; return { meta: { changes: 1 } };
          }
          if (sql.includes("status = 'consumed'")) {
            if (row.status !== 'approved_awaiting_machine') return { meta: { changes: 0 } };
            row.status = 'consumed'; row.result_iv = args[1]; row.result_ciphertext = args[2]; return { meta: { changes: 1 } };
          }
          if (sql.includes("status = 'approved_awaiting_machine'")) {
            if (row.status !== 'pending' || row.owner_id !== args[2]) return { meta: { changes: 0 } };
            row.status = 'approved_awaiting_machine'; return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, requests };
}

function b64url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function challenge(value: string) { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }

describe('remote MCP broker (#355)', () => {
  it('binds an approval to owner, machine proof, PKCE, and a single encrypted result', async () => {
    const { db } = memoryDb();
    const env = makeEnv({ DB: db, APP_BASE: 'https://api.example.test' });
    const owner = await testToken('gh:owner');
    const request_id = 'req_abcdefghijklmnopqrstuvwxyz012345';
    const machine_proof = 'machine-proof-abcdefghijklmnopqrstuvwxyz0123456789';
    const code_verifier = 'code-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    const create = await app.request('/v1/mcp/broker/v1/requests', {
      method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id, agent: { id: 'agent-1', label: 'Codex' }, machine: { id: 'machine-1', label: 'Remote Mac' }, resource: 'https://mcp.example.test', scopes: ['mcp:read'], code_challenge: await challenge(code_verifier), machine_proof_hash: await sha256Hex(machine_proof) }),
    }, env);
    expect(create.status).toBe(201);
    expect((await create.json() as { status_url: string }).status_url).not.toContain(machine_proof);

    const wrongOwner = await testToken('gh:other');
    const detail = await app.request(`/v1/mcp/broker/v1/requests/${request_id}`, { headers: { Authorization: `Bearer ${owner}` } }, env);
    expect(await detail.json()).toMatchObject({ agent: { label: 'Codex' }, machine: { label: 'Remote Mac' }, resource: 'https://mcp.example.test', scopes: ['mcp:read'] });
    expect((await app.request(`/v1/mcp/broker/v1/requests/${request_id}`, { headers: { Authorization: `Bearer ${wrongOwner}` } }, env)).status).toBe(409);
    expect((await app.request(`/v1/mcp/broker/v1/requests/${request_id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${wrongOwner}` } }, env)).status).toBe(409);
    expect((await app.request(`/v1/mcp/broker/v1/requests/${request_id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${owner}` } }, env)).status).toBe(200);

    const poll = await app.request('/v1/mcp/broker/v1/requests/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id, machine_proof }) }, env);
    expect((await poll.json() as { status: string }).status).toBe('approved_awaiting_machine');
    const badPkce = await app.request('/v1/mcp/broker/v1/requests/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id, machine_proof, code_verifier: 'wrong-verifier-abcdefghijklmnopqrstuvwxyz0123456789' }) }, env);
    expect(badPkce.status).toBe(409);

    const redeem = () => app.request('/v1/mcp/broker/v1/requests/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id, machine_proof, code_verifier }) }, env);
    const [first, second] = await Promise.all([redeem(), redeem()]);
    const responses = [first, second];
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const session = (await responses.find((r) => r.status === 200)!.json() as { session: string }).session;
    expect(session).toBeTruthy();
    const retry = await redeem();
    expect((await retry.json() as { session: string }).session).toBe(session);
    expect((await app.request('/v1/mcp/broker/v1/requests/connected', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id, machine_proof, code_verifier }) }, env)).status).toBe(200);
  });
});
