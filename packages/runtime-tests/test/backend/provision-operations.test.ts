import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const OWNER = 'gh:receipt-owner';
const OTHER = 'gh:receipt-other';
const intent = { templateId: 'template-app', options: { privateRepo: true, verify: true } };
const post = async (appId: string, token: string, requestIntent: unknown = intent) =>
  SELF.fetch(`${BASE}/v1/provision-operations`, json('POST', { appId, intent: requestIntent }, token));
const patch = async (appId: string, token: string, body: unknown) =>
  SELF.fetch(`${BASE}/v1/provision-operations/${appId}`, json('PATCH', body, token));
const body = <T>(response: Response) => response.json() as Promise<T>;

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await env.DB.prepare('DELETE FROM provision_operations').run();
  await env.DB.prepare('DELETE FROM provision_attempts').run();
  await seedUser(OWNER);
  await seedUser(OTHER);
});

describe('provision operation receipts on real D1 (#358)', () => {
  it('canonicalizes intent, joins identical concurrent requests, and conflicts on changed intent', async () => {
    const token = await session(OWNER);
    const [first, second] = await Promise.all([
      post('same-intent', token, { templateId: 'template-app', options: { verify: true, privateRepo: true } }),
      post('same-intent', token, { options: { privateRepo: true, verify: true }, templateId: 'template-app' }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    const a = await body<{ receipt: string }>(first);
    const b = await body<{ receipt: string }>(second);
    expect(a.receipt).toBe(b.receipt);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM provision_operations WHERE app_id = 'same-intent'").first<{ n: number }>())?.n).toBe(1);

    const conflict = await post('same-intent', token, { templateId: 'template-map', options: { privateRepo: true, verify: true } });
    expect(conflict.status).toBe(409);
  });

  it('rejects wrong owners and exhausted quota before creating a reservation', async () => {
    await seedApp('claimed-receipt-app', OWNER);
    const denied = await post('claimed-receipt-app', await session(OTHER));
    expect(denied.status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM provision_operations WHERE app_id = 'claimed-receipt-app'").first<{ n: number }>())?.n).toBe(0);

    const now = Date.now();
    await env.DB.prepare('INSERT INTO provision_attempts (key, window_start, count) VALUES (?, ?, ?)')
      .bind(`user:${OTHER}:h`, now, 10).run();
    const limited = await post('quota-receipt-app', await session(OTHER));
    expect(limited.status).toBe(429);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM provision_operations WHERE app_id = 'quota-receipt-app'").first<{ n: number }>())?.n).toBe(0);

    const owned = await body<{ attemptId: string }>(await post('creator-only-receipt', await session(OWNER)));
    expect((await patch('creator-only-receipt', await session(OTHER), { attemptId: owned.attemptId, status: 'completed' })).status).toBe(403);
  });

  it('recovers failed and expired attempts with one new lease, then stops at the bounded maximum', async () => {
    const token = await session(OWNER);
    const initial = await body<{ attemptId: string; attemptCount: number }>(await post('recoverable-receipt', token));
    expect((await patch('recoverable-receipt', token, { attemptId: initial.attemptId, status: 'failed' })).status).toBe(200);
    const recovered = await body<{ attemptId: string; attemptCount: number; status: string }>(await post('recoverable-receipt', token));
    expect(recovered).toMatchObject({ status: 'pending', attemptCount: 2 });
    expect(recovered.attemptId).not.toBe(initial.attemptId);

    let current = recovered;
    for (let count = 2; count < 5; count += 1) {
      expect((await patch('recoverable-receipt', token, { attemptId: current.attemptId, status: 'failed' })).status).toBe(200);
      current = await body<{ attemptId: string; attemptCount: number; status: string }>(await post('recoverable-receipt', token));
      expect(current.status).toBe('pending');
      expect(current.attemptCount).toBe(count + 1);
    }
    expect((await patch('recoverable-receipt', token, { attemptId: current.attemptId, status: 'failed' })).status).toBe(200);
    const exhausted = await body<{ status: string; attemptCount: number; joined: boolean }>(await post('recoverable-receipt', token));
    expect(exhausted).toMatchObject({ status: 'exhausted', attemptCount: 5, joined: true });

    const expired = await body<{ attemptId: string }>(await post('expired-receipt', token));
    await env.DB.prepare("UPDATE provision_operations SET lease_expires_at = 0 WHERE app_id = 'expired-receipt'").run();
    const resumed = await body<{ attemptId: string; attemptCount: number }>(await post('expired-receipt', token));
    expect(resumed.attemptCount).toBe(2);
    expect(resumed.attemptId).not.toBe(expired.attemptId);
    expect((await patch('expired-receipt', token, { attemptId: expired.attemptId, status: 'completed' })).status).toBe(409);
  });

  it('reports an expired fifth pending lease as terminal exhausted without renewing or charging quota', async () => {
    const token = await session(OWNER);
    const started = await body<{ attemptId: string }>(await post('fifth-expired-receipt', token));
    await env.DB.prepare(
      "UPDATE provision_operations SET attempt_count = 5, lease_expires_at = 0 WHERE app_id = 'fifth-expired-receipt'",
    ).run();
    const quotaBefore = await env.DB.prepare("SELECT count FROM provision_attempts WHERE key = ?")
      .bind(`user:${OWNER}:h`).first<{ count: number }>();

    const exhausted = await body<{ status: string; joined: boolean; attemptCount: number; attemptId: string }>(
      await post('fifth-expired-receipt', token),
    );
    const quotaAfter = await env.DB.prepare("SELECT count FROM provision_attempts WHERE key = ?")
      .bind(`user:${OWNER}:h`).first<{ count: number }>();

    expect(exhausted).toMatchObject({ status: 'exhausted', joined: true, attemptCount: 5, attemptId: started.attemptId });
    expect(quotaAfter).toEqual(quotaBefore);
    expect((await env.DB.prepare("SELECT attempt_count, lease_expires_at FROM provision_operations WHERE app_id = 'fifth-expired-receipt'")
      .first<{ attempt_count: number; lease_expires_at: number | null }>())).toEqual({ attempt_count: 5, lease_expires_at: 0 });
  });

  it('keeps legacy blank-intent receipts read-only as explicit reconciliation blockers', async () => {
    const token = await session(OWNER);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO provision_operations
         (receipt_id, creator_id, app_id, intent_hash, status, steps_json, attempt_count, lease_expires_at, attempt_id, created_at, updated_at)
       VALUES (?, ?, ?, '', 'failed', '[]', 1, NULL, NULL, ?, ?)`,
    ).bind('legacy-receipt', OWNER, 'legacy-receipt-app', now, now).run();

    const response = await post('legacy-receipt-app', token);
    expect(response.status).toBe(409);
    expect(await body<{ reconciliation: string; error: string }>(response)).toMatchObject({
      reconciliation: 'legacy_unreconciled',
      error: expect.stringContaining('no verified intent'),
    });
    expect(await env.DB.prepare("SELECT intent_hash, attempt_count FROM provision_operations WHERE app_id = 'legacy-receipt-app'")
      .first<{ intent_hash: string; attempt_count: number }>()).toEqual({ intent_hash: '', attempt_count: 1 });
    expect(await body<{ status: string }>(await SELF.fetch(`${BASE}/v1/provision-operations/legacy-receipt-app`, json('GET', undefined, token))))
      .toMatchObject({ status: 'legacy_unreconciled' });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provision_attempts WHERE key = ?")
      .bind(`user:${OWNER}:h`).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('preserves interruption evidence, rejects stale workers, and makes terminal receipts immutable', async () => {
    const token = await session(OWNER);
    const started = await body<{ attemptId: string }>(await post('interrupted-receipt', token));
    expect((await patch('interrupted-receipt', token, { attemptId: started.attemptId, status: 'pending' })).status).toBe(400);
    expect((await patch('interrupted-receipt', token, {
      attemptId: started.attemptId,
      steps: [{ name: 'repo_created', status: 'ok', detail: 'repo created with Bearer secret-token' }],
    })).status).toBe(200);
    await env.DB.prepare("UPDATE provision_operations SET lease_expires_at = 0 WHERE app_id = 'interrupted-receipt'").run();
    const resumed = await body<{ attemptId: string; steps: { name: string; detail: string }[] }>(await post('interrupted-receipt', token));
    expect(resumed.steps).toContainEqual(expect.objectContaining({ name: 'repo_created', detail: 'repo created with Bearer [redacted]' }));
    expect((await patch('interrupted-receipt', token, { attemptId: started.attemptId, status: 'completed' })).status).toBe(409);
    expect((await patch('interrupted-receipt', token, { attemptId: resumed.attemptId, status: 'completed' })).status).toBe(200);
    expect((await patch('interrupted-receipt', token, { attemptId: resumed.attemptId, status: 'failed' })).status).toBe(409);
    expect((await post('interrupted-receipt', token)).status).toBe(200);
  });
});
