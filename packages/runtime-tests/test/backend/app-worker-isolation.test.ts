import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { AppWorkerApi } from '../../../backend/src/rpc/app-worker-api';
import { disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { sha256Hex } from '../../../backend/src/lib/app-tokens';
import { sealSecret } from '../../../backend/src/lib/encryption';
import { egressFetch } from '../../../backend/src/lib/app-worker-egress';
import { createShim } from '../../../backend/src/app-worker-shim/entry';
import { SIGNATURE_HEADER, signatureHeader } from '../../../backend/src/app-worker-shim/signature';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #267 / ADR-009 §6 B.7 on real D1 and R2: with two apps' workers live, app A's
// worker cannot act as app B. Same harness as app-worker-pas.test.ts.
//
//   apps `a` and `b` belong to gh:admin; A's worker token is A_TOKEN, B's is B_TOKEN.
//   Each has a running invocation: A_INV and B_INV.

const A_TOKEN = 'a'.repeat(64);
const B_TOKEN = 'b'.repeat(64);
const A_INV = 'evt-a:1';
const B_INV = 'evt-b:1';

const pas = (props: unknown) => new AppWorkerApi({ props } as never, env);
const ctxA = (over: Record<string, unknown> = {}) => ({ token: A_TOKEN, invocation: A_INV, ...over });
const ctxB = (over: Record<string, unknown> = {}) => ({ token: B_TOKEN, invocation: B_INV, ...over });
const refused = (p: Promise<unknown>) => expect(p).rejects.toThrow(/^Unauthorized:/);
const callsOf = async (id: string) => (await env.DB.prepare('SELECT pas_calls FROM app_worker_invocations WHERE id = ?').bind(id).first<{ pas_calls: number }>())?.pas_calls;

async function seedWorker(appId: string, token: string) {
  await env.DB.prepare(
    `INSERT INTO app_workers (app_id, enabled, backend, token_hash, deployed_at, config_version) VALUES (?, 1, 'loader', ?, ?, 1)
     ON CONFLICT(app_id) DO UPDATE SET enabled = 1, token_hash = excluded.token_hash, deployed_at = excluded.deployed_at`,
  ).bind(appId, await sha256Hex(token), Date.now()).run();
}
const invocation = (id: string, appId: string) => env.DB.prepare(
  "INSERT OR REPLACE INTO app_worker_invocations (id, app_id, event_id, type, attempt, status, pas_calls, started_at) VALUES (?, ?, ?, 'schedule', 1, 'running', 0, ?)",
).bind(id, appId, id.split(':')[0], Date.now()).run();
async function seedSecret(appId: string, name: string, value: string) {
  const sealed = await sealSecret(value, env.APP_SECRET_KEK!);
  await env.DB.prepare('INSERT INTO app_secrets (app_id, name, key_ciphertext, dek_wrapped, iv, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(appId, name, sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, Date.now()).run();
}

beforeEach(async () => {
  mockNetwork();
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  for (const t of ['app_worker_invocations', 'app_worker_manifest', 'app_secrets', 'app_log_usage', 'app_worker_usage']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:admin', 'admin');
  await seedApp('a', 'gh:admin');
  await seedApp('b', 'gh:admin');
  // Both apps declare GITHUB_TOKEN, so only the app id separates the two values.
  for (const id of ['a', 'b']) {
    await env.DB.prepare('INSERT OR REPLACE INTO app_worker_manifest (app_id, secrets, created_at) VALUES (?, ?, ?)').bind(id, JSON.stringify(['GITHUB_TOKEN']), Date.now()).run();
  }
  await seedSecret('a', 'GITHUB_TOKEN', 'ghp_A');
  await seedSecret('b', 'GITHUB_TOKEN', 'ghp_B');
  await seedWorker('a', A_TOKEN);
  await seedWorker('b', B_TOKEN);
  await invocation(A_INV, 'a');
  await invocation(B_INV, 'b');
});
afterEach(async () => {
  fetchMock.assertNoPendingInterceptors();
  for (const id of ['a', 'b']) {
    const keys = (await env.STORAGE.list({ prefix: `${id}/` })).objects.map((o) => o.key);
    if (keys.length) await env.STORAGE.delete(keys);
  }
});

describe('PAS identity: one app\'s worker cannot act as another (#267)', () => {
  it("B's token with A's props, and A's with B's, is refused — and neither spends a call", async () => {
    await refused(pas({ appId: 'a' }).log('info', 'x', undefined, ctxB()));
    await refused(pas({ appId: 'b' }).log('info', 'x', undefined, ctxA()));
    await refused(pas({ appId: 'a' }).secrets.get('GITHUB_TOKEN', ctxB()));
    await refused(pas({ appId: 'b' }).storage.get('k', ctxA()));
    expect(await callsOf(A_INV)).toBe(0);
    expect(await callsOf(B_INV)).toBe(0);
  });

  it("A's own token with B's running invocation is refused: the invocation must be the app's own", async () => {
    await refused(pas({ appId: 'a' }).log('info', 'x', undefined, ctxA({ invocation: B_INV })));
    expect(await callsOf(B_INV)).toBe(0);
  });

  it('a worker bound to no app is refused whatever token it holds', async () => {
    await refused(pas(undefined).secrets.get('GITHUB_TOKEN', ctxA()));
    await refused(pas({}).secrets.get('GITHUB_TOKEN', ctxB()));
  });

  it('the right token still works, and only for its own app', async () => {
    expect(await pas({ appId: 'a' }).secrets.get('GITHUB_TOKEN', ctxA())).toBe('ghp_A');
    expect(await pas({ appId: 'b' }).secrets.get('GITHUB_TOKEN', ctxB())).toBe('ghp_B');
  });
});

describe('secrets, storage and logs are per app (#267)', () => {
  it('a worker reads only its own app\'s secret, even under the same name', async () => {
    expect(await pas({ appId: 'a' }).secrets.get('GITHUB_TOKEN', ctxA())).toBe('ghp_A');
    // Declared only by B: A gets nothing, not B's value.
    await env.DB.prepare('UPDATE app_worker_manifest SET secrets = ? WHERE app_id = ?').bind(JSON.stringify([]), 'a').run();
    await seedSecret('b', 'ONLY_B', 'ghp_only_b');
    await env.DB.prepare('UPDATE app_worker_manifest SET secrets = ? WHERE app_id = ?').bind(JSON.stringify(['ONLY_B']), 'b').run();
    expect(await pas({ appId: 'a' }).secrets.get('ONLY_B', ctxA())).toBeNull();
    expect(await pas({ appId: 'a' }).secrets.get('GITHUB_TOKEN', ctxA())).toBeNull();
  });

  it("A's storage lands under a/_worker/ and B cannot read it, by name or by path tricks", async () => {
    await pas({ appId: 'a' }).storage.put('note.json', '{"a":1}', {}, ctxA());
    expect(await env.STORAGE.head('a/_worker/note.json')).not.toBeNull();
    expect(await env.STORAGE.head('b/_worker/note.json')).toBeNull();
    expect(await pas({ appId: 'b' }).storage.get('note.json', ctxB())).toBeNull();
    for (const key of ['../a/_worker/note.json', '../../a/_worker/note.json', '/a/_worker/note.json', 'a/../../a/_worker/note.json', './note.json', '']) {
      await expect(pas({ appId: 'b' }).storage.get(key, ctxB()), key).rejects.toThrow(/^BadRequest:/);
    }
  });

  it("A's worker log lines never appear in B's logs, and B's budget is untouched", async () => {
    expect(await pas({ appId: 'a' }).log('warn', 'a-only line', undefined, ctxA())).toBe(true);
    const count = async (id: string) => Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM app_logs WHERE app_id = ? AND message = 'a-only line'").bind(id).first<{ n: number }>())?.n);
    expect(await count('a')).toBe(1);
    expect(await count('b')).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM app_log_usage WHERE app_id = 'b'").first<{ n: number }>())?.n).toBe(0);
  });

  it("an owner's file list never shows a worker's objects, and a worker's key cannot name an owner file", async () => {
    await env.STORAGE.put('b/owner-file.txt', 'private');
    await pas({ appId: 'a' }).storage.put('x', 'y', {}, ctxA());
    expect(await pas({ appId: 'b' }).storage.get('owner-file.txt', ctxB())).toBeNull();
    const listing = await SELF.fetch(`${BASE}/v1/apps/a/files`, json('GET', undefined, await session('gh:admin')));
    expect((await listing.json() as { files: unknown[] }).files).toEqual([]);
  });
});

describe("a worker cannot be forged, or reached from another app's worker (#267)", () => {
  const KEY_A = 'k'.repeat(64);
  const KEY_B = 'j'.repeat(64);
  const body = JSON.stringify({ v: 1, id: 'e1', app_id: 'a', type: 'schedule', attempt: 1 });
  const now = 1_800_000_000_000;
  const shimFor = (key: string) => {
    let loaded = 0;
    const shim = createShim(async () => { loaded++; return { default: { fetch: async () => new Response('ran') } }; }, () => now);
    return { call: (header: string | null) => shim.fetch(new Request('https://w/', { method: 'POST', headers: header ? { [SIGNATURE_HEADER]: header } : {}, body }), { PAS_EVENT_KEY: key }, {}), loaded: () => loaded };
  };

  it("A's shim runs an envelope signed with A's key, and refuses unsigned ones and ones signed with B's key — loading nothing", async () => {
    const a = shimFor(KEY_A);
    expect((await a.call(null)).status).toBe(401);
    expect((await a.call(await signatureHeader(body, [KEY_B], now / 1000))).status).toBe(401);
    expect(a.loaded()).toBe(0);
    expect((await a.call(await signatureHeader(body, [KEY_A], now / 1000))).status).toBe(200);
    expect(a.loaded()).toBe(1);
  });

  it("the egress gateway answers 403 to A's fetches of B's worker, B's data worker and the platform API, and nothing leaves", async () => {
    const points: unknown[] = [];
    const gateway = { APP_WORKER_EGRESS: { writeDataPoint: (p: unknown) => points.push(p) } };
    let reached = 0;
    const upstream = (async () => { reached++; return new Response('leaked'); }) as unknown as typeof fetch;
    for (const url of [
      `https://pas-app-b.${env.DATA_WORKER_HOST}/`,
      `https://pas-data-b.${env.DATA_WORKER_HOST}/health`,
      'https://api.proappstore.online/v1/apps/b/secrets',
    ]) {
      const res = await egressFetch(gateway, 'a', new Request(url), upstream);
      expect(res.status, url).toBe(403);
    }
    expect(reached).toBe(0);
    expect(points.map((p) => (p as { blobs: string[]; indexes: string[] }).indexes[0])).toEqual(['a', 'a', 'a']);
    expect(points.every((p) => (p as { blobs: string[] }).blobs[2] === 'block')).toBe(true);
  });
});
