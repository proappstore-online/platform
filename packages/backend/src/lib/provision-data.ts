import type { Step } from '@proappstore/build-core';
import { deployDataWorker } from './deploy-worker.js';

export interface ProvisionDataArgs {
  appId: string;
  /** Platform user id recorded as the app's creator (for payouts). */
  creatorId: string;
  /** Human label for the record_app step detail (defaults to creatorId). */
  creatorLabel?: string;
  cfToken: string;
  cfAccount: string;
  db: D1Database;
  /** SESSION_SIGNING_KEY — passed to the data-worker for local JWT verification. */
  sessionSigningKey: string;
  /** INTERNAL_TOKEN — bound on the data-worker so it trusts the platform
   *  actions-executor. Empty string leaves the internal path inert (fail-closed). */
  internalToken?: string;
}

/**
 * Provision an app's DATA plane: D1 database + data worker + PAS app record.
 * Idempotent — D1 create skips when it already exists, the app record is
 * INSERT OR IGNORE, and re-deploying the (generic) data worker is harmless.
 *
 * Shared by `/v1/provision` (the CLI/SDK publish path) and `/v1/provision-data`
 * (the Agent Teams deploy stage, service-to-service) so a CLI-published app and
 * an agent-built app get the SAME data layer — closing the parity gap where
 * agent apps had no D1/data worker and `app.data` 404'd at runtime.
 */
export async function provisionData(
  args: ProvisionDataArgs,
): Promise<{ steps: Step[]; dataWorkerUrl: string; dbId: string }> {
  const { appId, creatorId, creatorLabel, cfToken, cfAccount, db, sessionSigningKey, internalToken } = args;
  const steps: Step[] = [];

  // 1. Create D1 database (skip if it already exists)
  let dbId = '';
  const dbName = `pas-data-${appId}`;
  try {
    const dbRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/d1/database`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: dbName }),
    });
    const dbData = (await dbRes.json()) as { success: boolean; result?: { uuid: string }; errors?: { message: string }[] };
    if (dbData.success && dbData.result) {
      dbId = dbData.result.uuid;
      steps.push({ name: 'create_d1', status: 'ok', detail: `${dbName} (${dbId})` });
    } else {
      const err = dbData.errors?.[0]?.message || 'unknown';
      if (err.includes('already exists')) {
        const listRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/d1/database?name=${dbName}`,
          { headers: { Authorization: `Bearer ${cfToken}` } },
        );
        const listData = (await listRes.json()) as { result?: { uuid: string; name: string }[] };
        const existing = listData.result?.find((d) => d.name === dbName);
        if (existing) {
          dbId = existing.uuid;
          steps.push({ name: 'create_d1', status: 'skip', detail: `${dbName} already exists (${dbId})` });
        } else {
          steps.push({ name: 'create_d1', status: 'fail', detail: 'exists per create but list returned nothing' });
        }
      } else {
        steps.push({ name: 'create_d1', status: 'fail', detail: err });
      }
    }
  } catch (e) {
    steps.push({ name: 'create_d1', status: 'fail', detail: String(e) });
  }

  // 2. Deploy the data worker bound to that D1
  let dataWorkerUrl = '';
  if (dbId) {
    try {
      const result = await deployDataWorker(appId, dbId, cfToken, cfAccount, sessionSigningKey, internalToken ?? '');
      dataWorkerUrl = result.url;
      steps.push({ name: 'deploy_worker', status: result.ok ? 'ok' : 'fail', detail: result.detail });
    } catch (e) {
      steps.push({ name: 'deploy_worker', status: 'fail', detail: String(e) });
    }
  } else {
    steps.push({ name: 'deploy_worker', status: 'skip', detail: 'No D1 database created' });
  }

  // 3. Record the app in PAS (creator → payouts; d1 id → data worker binding).
  //    Skip when D1 didn't yield an id — recording a row with an empty
  //    d1_database_id would freeze it (plain INSERT OR IGNORE never backfills),
  //    leaving the data worker bound to nothing. The D1 step already failed, so
  //    success=false and the caller retries. On retry we upsert: a row whose
  //    d1_database_id was left empty by an earlier partial run gets healed,
  //    while a good id (and the original creator_id) is preserved.
  if (!dbId) {
    steps.push({ name: 'record_app', status: 'skip', detail: 'no D1 id yet — record deferred to retry' });
  } else {
    try {
      await db
        .prepare(
          `INSERT INTO apps (id, creator_id, d1_database_id, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET d1_database_id = excluded.d1_database_id
           WHERE apps.d1_database_id IS NULL OR apps.d1_database_id = ''`,
        )
        .bind(appId, creatorId, dbId, Date.now())
        .run();
      steps.push({ name: 'record_app', status: 'ok', detail: `creator: ${creatorLabel ?? creatorId}` });

      // Auto-create a dev services profile for the creator (no-op if exists)
      try {
        const now = Date.now();
        await db
          .prepare(
            `INSERT INTO dev_profiles (creator_id, prompt_rate_cents, available, completed_engagements, rating_count, created_at, updated_at)
             VALUES (?, 100, 1, 0, 0, ?, ?)
             ON CONFLICT(creator_id) DO NOTHING`,
          )
          .bind(creatorId, now, now)
          .run();
      } catch { /* non-fatal — profile creation is best-effort */ }
    } catch (e) {
      steps.push({ name: 'record_app', status: 'fail', detail: String(e) });
    }
  }

  return { steps, dataWorkerUrl, dbId };
}
