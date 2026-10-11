import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const OWNER = 'gh:receipt-owner';
const OTHER = 'gh:receipt-other';
const intent = { templateId: 'template-app', options: { privateRepo: true, verify: true } };
const provisionIntent = (appId: string, overrides: Record<string, unknown> = {}) => ({
  appId,
  template: 'not-a-published-template',
  ...overrides,
});
const post = async (appId: string, token: string, requestIntent: unknown = intent, bootstrapIntent: unknown = requestIntent) =>
  SELF.fetch(`${BASE}/v1/provision-operations`, json('POST', { appId, intent: requestIntent, bootstrapIntent }, token));
const patch = async (appId: string, token: string, body: unknown) =>
  SELF.fetch(`${BASE}/v1/provision-operations/${appId}`, json('PATCH', body, token));
const provision = (appId: string, token: string, receipt?: { receipt: string; attemptId: string }, request: Record<string, unknown> = {}) =>
  SELF.fetch(`${BASE}/v1/provision`, json('POST', {
    appId,
    // Refuse after admission, before any network provisioning side effects.
    template: 'not-a-published-template',
    ...request,
    ...(receipt ? { provisionReceipt: receipt.receipt, provisionAttemptId: receipt.attemptId } : {}),
  }, token));
const body = <T>(response: Response) => response.json() as Promise<T>;
const quotaCount = async (userId: string) => (await env.DB.prepare('SELECT count FROM provision_attempts WHERE key = ?')
  .bind(`user:${userId}:h`).first<{ count: number }>())?.count ?? 0;

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await env.DB.prepare('DELETE FROM provision_operations').run();
  await env.DB.prepare('DELETE FROM provision_admissions').run();
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

  it('joins only an identical bootstrap plan, including name, privacy, and template source', async () => {
    const token = await session(OWNER);
    const appId = 'bootstrap-fingerprint';
    const request = provisionIntent(appId);
    const bootstrap = { name: 'Original', privateRepo: true, templateRepo: 'template-app', templateRef: 'main', reuseExistingRepo: true, verify: true };
    expect((await post(appId, token, request, bootstrap)).status).toBe(201);
    for (const changed of [
      { ...bootstrap, name: 'Renamed' },
      { ...bootstrap, privateRepo: false },
      { ...bootstrap, templateRepo: 'template-map' },
      { ...bootstrap, templateRef: 'release' },
    ]) {
      expect((await post(appId, token, request, changed)).status).toBe(409);
    }
    expect(await quotaCount(OWNER)).toBe(1);
  });

  it('rejects wrong owners and retains a non-executable denied receipt', async () => {
    await seedApp('claimed-receipt-app', OWNER);
    const denied = await post('claimed-receipt-app', await session(OTHER));
    expect(denied.status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM provision_operations WHERE app_id = 'claimed-receipt-app'").first<{ n: number }>())?.n).toBe(0);

    const now = Date.now();
    await env.DB.prepare('INSERT INTO provision_attempts (key, window_start, count) VALUES (?, ?, ?)')
      .bind(`user:${OTHER}:h`, now, 10).run();
    const otherToken = await session(OTHER);
    const limited = await post('quota-receipt-app', otherToken, provisionIntent('quota-receipt-app'));
    expect(limited.status).toBe(429);
    const limitedReceipt = await body<{ receipt: string; attemptId: string }>(
      await SELF.fetch(`${BASE}/v1/provision-operations/quota-receipt-app`, json('GET', undefined, otherToken)),
    );
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM provision_operations WHERE app_id = 'quota-receipt-app'").first<{ n: number }>())?.n).toBe(1);
    expect(await env.DB.prepare("SELECT status, claimed_at FROM provision_admissions WHERE app_id = 'quota-receipt-app'")
      .first<{ status: string; claimed_at: number | null }>()).toEqual({ status: 'denied', claimed_at: null });
    // A quota-denied receipt is evidence only; it cannot be raced into remote work.
    expect((await provision('quota-receipt-app', otherToken, limitedReceipt)).status).toBe(409);

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

  it('#369: only a platform-classified template-copy failure may be retried under a new intent', async () => {
    const token = await session(OWNER);
    const boot = { templateId: 'template-marketplace', name: 'App', privateRepo: true, verify: true };
    const intentA = { appId: 'rebind-receipt', template: 'template-marketplace', templateRev: 'a'.repeat(40) };
    const intentB = { ...intentA, templateRev: 'b'.repeat(40) };
    const stored = async (appId: string) => (await env.DB.prepare('SELECT intent_hash, failure_code, attempt_count FROM provision_operations WHERE app_id = ?')
      .bind(appId).first<{ intent_hash: string; failure_code: string | null; attempt_count: number }>())!;
    const internalPatch = (appId: string, body: unknown) => SELF.fetch(`${BASE}/v1/provision-operations/${appId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Internal-Token': (env as unknown as { INTERNAL_TOKEN: string }).INTERNAL_TOKEN },
      body: JSON.stringify(body),
    });

    // An unrelated failure (no classification) cannot change the receipt's intent.
    const first = await body<{ attemptId: string }>(await post('rebind-receipt', token, intentA, boot));
    const hashA = (await stored('rebind-receipt')).intent_hash;
    expect((await patch('rebind-receipt', token, { attemptId: first.attemptId, status: 'failed', steps: [{ name: 'template_revision', status: 'fail', detail: 'revision_mismatch: typed by hand' }] })).status).toBe(200);
    // #374: and it is a conflict, never a "join" of an execution the caller did not review.
    expect((await post('rebind-receipt', token, intentB, boot)).status).toBe(409);
    expect(await stored('rebind-receipt')).toMatchObject({ intent_hash: hashA, failure_code: null, attempt_count: 1 });
    // It still resumes with its own intent, as before.
    const resumed = await body<{ attemptId: string; attemptCount: number }>(await post('rebind-receipt', token, intentA, boot));
    expect(resumed.attemptCount).toBe(2);

    // The owner's session cannot establish the classification.
    expect((await patch('rebind-receipt', token, { attemptId: resumed.attemptId, status: 'failed', failureCode: 'template_copy_mismatch' })).status).toBe(403);
    expect(await stored('rebind-receipt')).toMatchObject({ failure_code: null });
    // Nor can the platform attach it to anything but a failure.
    expect((await internalPatch('rebind-receipt', { attemptId: resumed.attemptId, failureCode: 'template_copy_mismatch' })).status).toBe(400);
    expect((await internalPatch('rebind-receipt', { attemptId: resumed.attemptId, status: 'failed', failureCode: 'anything' })).status).toBe(400);

    // The platform classifies a template-copy mismatch: now, and only now, a new intent may retry it.
    expect((await internalPatch('rebind-receipt', { attemptId: resumed.attemptId, status: 'failed', failureCode: 'template_copy_mismatch' })).status).toBe(200);
    expect(await stored('rebind-receipt')).toMatchObject({ failure_code: 'template_copy_mismatch' });
    // A changed bootstrap plan is still a conflict.
    expect((await post('rebind-receipt', token, intentB, { ...boot, name: 'Renamed' })).status).toBe(409);
    const retried = await body<{ attemptCount: number; status: string; joined: boolean; failureCode?: string }>(await post('rebind-receipt', token, intentB, boot));
    expect(retried).toMatchObject({ status: 'pending', attemptCount: 3, joined: false });
    expect(retried.failureCode).toBeUndefined();
    const rebound = await stored('rebind-receipt');
    expect(rebound.intent_hash).not.toBe(hashA);
    expect(rebound.failure_code).toBeNull(); // cleared: it authorised exactly one retry

    // A live pending lease, or an expired one, is never re-bound — and (#374) a
    // different intent is refused rather than reported as joining it.
    expect((await post('rebind-receipt', token, intentA, boot)).status).toBe(409);
    expect((await stored('rebind-receipt')).intent_hash).toBe(rebound.intent_hash);
    await post('expired-rebind', token, { ...intentA, appId: 'expired-rebind' }, boot);
    const hashExpired = (await stored('expired-rebind')).intent_hash;
    await env.DB.prepare("UPDATE provision_operations SET lease_expires_at = 0 WHERE app_id = 'expired-rebind'").run();
    expect((await post('expired-rebind', token, { ...intentB, appId: 'expired-rebind' }, boot)).status).toBe(409);
    expect((await stored('expired-rebind')).intent_hash).toBe(hashExpired);
  });

  it('#374: a classified failure rebinds only an intent that differs in templateRev alone', async () => {
    const token = await session(OWNER);
    const boot = { templateId: 'template-marketplace', name: 'App', privateRepo: true, verify: true };
    const intentA = { appId: 'rev-only', repoOwner: 'proappstore-online', repoName: 'rev-only', skipCompliance: false, template: 'template-marketplace', templateRev: 'a'.repeat(40) };
    const internalFail = (attemptId: string, failureCode: string) => SELF.fetch(`${BASE}/v1/provision-operations/rev-only`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Internal-Token': (env as unknown as { INTERNAL_TOKEN: string }).INTERNAL_TOKEN },
      body: JSON.stringify({ attemptId, status: 'failed', failureCode }),
    });
    const stored = async () => (await env.DB.prepare("SELECT intent_hash, attempt_count FROM provision_operations WHERE app_id = 'rev-only'").first<{ intent_hash: string; attempt_count: number }>())!;

    const first = await body<{ attemptId: string }>(await post('rev-only', token, intentA, boot));
    expect((await internalFail(first.attemptId, 'provision_incomplete')).status).toBe(200);
    const before = await stored();
    // Anything but the revision changed — another template, compliance skipped, the repo — is refused.
    for (const changed of [{ template: 'template-app' }, { skipCompliance: true }, { repoName: 'elsewhere' }, { allowUnapprovedTemplate: true }]) {
      expect((await post('rev-only', token, { ...intentA, ...changed }, boot)).status).toBe(409);
    }
    expect(await stored()).toEqual(before);
    // The revision alone may change, or be dropped.
    const rebound = await post('rev-only', token, { ...intentA, templateRev: 'b'.repeat(40) }, boot);
    expect(rebound.status).toBe(200);
    expect(await body(rebound)).toMatchObject({ status: 'pending', attemptCount: 2, joined: false });
    expect((await stored()).intent_hash).not.toBe(before.intent_hash);
  });

  it('#374: a receipt from before migration 0096 recovers only under its identical intent', async () => {
    const token = await session(OWNER);
    const boot = { templateId: 'template-marketplace', name: 'App', privateRepo: true, verify: true };
    const intentA = { appId: 'pre-0096', template: 'template-marketplace', templateRev: 'a'.repeat(40) };
    const first = await body<{ attemptId: string }>(await post('pre-0096', token, intentA, boot));
    await patch('pre-0096', token, { attemptId: first.attemptId, status: 'failed' });
    await env.DB.prepare("UPDATE provision_operations SET failure_code = 'template_copy_mismatch', revision_free_intent_hash = NULL WHERE app_id = 'pre-0096'").run();
    expect((await post('pre-0096', token, { ...intentA, templateRev: 'b'.repeat(40) }, boot)).status).toBe(409);
    expect(await body(await post('pre-0096', token, intentA, boot))).toMatchObject({ status: 'pending', attemptCount: 2 });
  });

  it('#374: a different intent never reports joining a live receipt it did not start', async () => {
    const token = await session(OWNER);
    const boot = { templateId: 'template-marketplace', name: 'App', privateRepo: true, verify: true };
    const intentA = { appId: 'two-plans', template: 'template-marketplace', templateRev: 'a'.repeat(40) };
    expect((await post('two-plans', token, intentA, boot)).status).toBe(201);
    const second = await post('two-plans', token, { ...intentA, templateRev: 'b'.repeat(40) }, boot);
    expect(second.status).toBe(409);
    expect(await body(second)).toEqual({ error: 'a provisioning receipt already exists for this app with a different intent' });
    expect(await body(await post('two-plans', token, intentA, boot))).toMatchObject({ joined: true, status: 'pending' });
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

  it('charges a receipt-backed provision exactly once and atomically refuses a concurrent replay', async () => {
    const token = await session(OWNER);
    const receipt = await body<{ receipt: string; attemptId: string }>(await post('single-admission', token, provisionIntent('single-admission')));
    expect(await quotaCount(OWNER)).toBe(1);

    // The first request claims the admission and reaches template validation;
    // the concurrent replay cannot claim it or create a second execution.
    const [first, replay] = await Promise.all([
      provision('single-admission', token, receipt),
      provision('single-admission', token, receipt),
    ]);
    expect([first.status, replay.status].sort()).toEqual([400, 409]);
    expect(await quotaCount(OWNER)).toBe(1);
  });

  it('charges direct provision calls normally, and fails closed when quota storage is unavailable', async () => {
    const token = await session(OTHER);
    expect((await provision('direct-admission', token)).status).toBe(400);
    expect(await quotaCount(OTHER)).toBe(1);

    await env.DB.prepare(
      `CREATE TRIGGER fail_receipt_quota BEFORE INSERT ON provision_attempts
         WHEN NEW.key = 'user:${OTHER}:h'
       BEGIN SELECT RAISE(ABORT, 'quota store unavailable'); END`,
    ).run();
    // Reset the ordinary direct-call row so this receipt must attempt the
    // failing insert rather than being rejected by a limit.
    await env.DB.prepare('DELETE FROM provision_attempts WHERE key = ?').bind(`user:${OTHER}:h`).run();
    const unavailable = await post('unavailable-admission', token, provisionIntent('unavailable-admission'));
    expect(unavailable.status).toBe(503);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM provision_operations WHERE app_id = 'unavailable-admission'")
      .first<{ n: number }>())?.n).toBe(1);
    expect(await env.DB.prepare("SELECT status, claimed_at FROM provision_admissions WHERE app_id = 'unavailable-admission'")
      .first<{ status: string; claimed_at: number | null }>()).toEqual({ status: 'unavailable', claimed_at: null });
    await env.DB.prepare('DROP TRIGGER fail_receipt_quota').run();
  });

  it('refuses stale, wrong-owner, and intent-mismatched receipt references without charging quota', async () => {
    const ownerToken = await session(OWNER);
    const receipt = await body<{ receipt: string; attemptId: string }>(await post('receipt-guarded', ownerToken, provisionIntent('receipt-guarded')));
    const before = await quotaCount(OWNER);

    expect((await provision('receipt-guarded', await session(OTHER), receipt)).status).toBe(409);
    expect((await provision('different-receipt-app', ownerToken, receipt)).status).toBe(409);
    await env.DB.prepare('UPDATE provision_admissions SET intent_hash = ? WHERE app_id = ?')
      .bind('different-intent', 'receipt-guarded').run();
    expect((await provision('receipt-guarded', ownerToken, receipt)).status).toBe(409);
    await env.DB.prepare('UPDATE provision_operations SET lease_expires_at = 0 WHERE app_id = ?')
      .bind('receipt-guarded').run();
    expect((await provision('receipt-guarded', ownerToken, receipt)).status).toBe(409);
    expect(await quotaCount(OWNER)).toBe(before);
  });

  it('keeps staged evidence non-executable during a join and rejects a changed actual request body', async () => {
    const token = await session(OWNER);
    const appId = 'staged-admission';
    const receipt = await body<{ receipt: string; attemptId: string }>(await post(appId, token, provisionIntent(appId, { skipCompliance: false })));
    const before = await quotaCount(OWNER);

    // This models the exact interleaving after the receipt route has staged a
    // row but before it has promoted it after quota success. Joining is safe;
    // claiming is refused because only admitted rows are executable.
    await env.DB.prepare("UPDATE provision_admissions SET status = 'pending', claimed_at = NULL WHERE app_id = ?")
      .bind(appId).run();
    const [joined, blockedClaim] = await Promise.all([
      post(appId, token, provisionIntent(appId, { skipCompliance: false })),
      provision(appId, token, receipt, { skipCompliance: false }),
    ]);
    expect(joined.status).toBe(200);
    expect(blockedClaim.status).toBe(409);
    expect(await env.DB.prepare('SELECT status, claimed_at FROM provision_admissions WHERE app_id = ?').bind(appId)
      .first<{ status: string; claimed_at: number | null }>()).toEqual({ status: 'pending', claimed_at: null });
    expect(await quotaCount(OWNER)).toBe(before);

    // A changed template is rejected against the server-hashed actual request
    // before it can claim this now-admitted lease or touch remote provisioning.
    await env.DB.prepare("UPDATE provision_admissions SET status = 'admitted' WHERE app_id = ?").bind(appId).run();
    expect((await provision(appId, token, receipt, { template: 'template-map', skipCompliance: false })).status).toBe(409);
    expect(await env.DB.prepare('SELECT claimed_at FROM provision_admissions WHERE app_id = ?').bind(appId)
      .first<{ claimed_at: number | null }>()).toEqual({ claimed_at: null });
    expect(await quotaCount(OWNER)).toBe(before);
  });

  it('rejects invalid consequential request types before hashing, claiming, or charging', async () => {
    const token = await session(OWNER);
    const appId = 'typed-request';
    const receipt = await body<{ receipt: string; attemptId: string }>(await post(appId, token, provisionIntent(appId, { skipPublish: false })));
    const before = await quotaCount(OWNER);
    const response = await provision(appId, token, receipt, { skipPublish: 'true' });
    expect(response.status).toBe(400);
    expect(await env.DB.prepare('SELECT claimed_at FROM provision_admissions WHERE app_id = ?').bind(appId)
      .first<{ claimed_at: number | null }>()).toEqual({ claimed_at: null });
    expect(await quotaCount(OWNER)).toBe(before);
  });
});
