import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, resetTables, seedUser, session } from './helpers';

beforeEach(async () => { mockNetwork(); await resetTables(); await env.DB.prepare('DELETE FROM user_api_keys').run(); });

/**
 * #3 on real D1 + WebCrypto: an owner stores a BYO key, it rests encrypted, and
 * the agent-teams worker's internal resolve path gets the plaintext back —
 * only with INTERNAL_TOKEN + X-Owner-Id, only for that owner.
 */
describe('BYO key vault', () => {
  it('seals on PUT, never stores the plaintext, and resolves it only over the internal path for the right owner', async () => {
    await seedUser('gh:1', 'alice');
    const alice = await session('gh:1');
    const put = await SELF.fetch(`${BASE}/v1/keys/anthropic`, json('PUT', { value: 'sk-ant-api03-runtime-test-key', label: 'my key' }, alice));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    // Encrypted at rest: the row holds ciphertext + a wrapped DEK, not the key.
    const row = await env.DB.prepare("SELECT key_ciphertext, dek_wrapped, iv, label FROM user_api_keys WHERE user_id = 'gh:1' AND provider = 'anthropic'").first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer; label: string }>();
    expect(row?.label).toBe('my key');
    const bytes = new Uint8Array(row!.key_ciphertext);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes)).not.toContain('sk-ant');
    expect(new Uint8Array(row!.iv).byteLength).toBe(12);

    // The owner sees that a key exists — never its value.
    const status = await SELF.fetch(`${BASE}/v1/keys/status`, json('GET', undefined, alice));
    const listed = (await status.json()) as { keys: { provider: string; label: string }[] };
    expect(listed.keys).toEqual([expect.objectContaining({ provider: 'anthropic', label: 'my key' })]);
    expect(JSON.stringify(listed)).not.toContain('sk-ant');

    // Internal resolve (what agent-teams calls over the service binding): plaintext back.
    const internal = (h: Record<string, string>) => SELF.fetch(`${BASE}/v1/keys/resolve/anthropic`, { headers: h });
    expect(await (await internal({ 'X-Internal-Token': env.INTERNAL_TOKEN, 'X-Owner-Id': 'gh:1' })).json()).toEqual({ key: 'sk-ant-api03-runtime-test-key' });
    // Another owner: no key. Missing owner header: 400. No auth at all: 401.
    expect(await (await internal({ 'X-Internal-Token': env.INTERNAL_TOKEN, 'X-Owner-Id': 'gh:2' })).json()).toEqual({ key: null });
    expect((await internal({ 'X-Internal-Token': env.INTERNAL_TOKEN })).status).toBe(400);
    expect((await internal({})).status).toBe(401);
    expect((await internal({ 'X-Internal-Token': 'wrong', 'X-Owner-Id': 'gh:1' })).status).toBe(401);
  });

  it('refuses a key that does not look like the provider\'s, and an unknown provider', async () => {
    await seedUser('gh:1', 'alice');
    const alice = await session('gh:1');
    expect((await SELF.fetch(`${BASE}/v1/keys/anthropic`, json('PUT', { value: 'sk-not-anthropic' }, alice))).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/v1/keys/nope`, json('PUT', { value: 'x' }, alice))).status).toBe(400);
    expect(await (await SELF.fetch(`${BASE}/v1/keys/resolve/anthropic`, { headers: { 'X-Internal-Token': env.INTERNAL_TOKEN, 'X-Owner-Id': 'gh:1' } })).json()).toEqual({ key: null });
  });
});
