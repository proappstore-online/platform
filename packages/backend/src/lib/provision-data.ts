import { appClaim, type Step } from '@proappstore/build-core';
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
  /** #178: approved-template id the app was scaffolded from (validated by the caller). */
  templateId?: string;
  /** #178: exact source commit of the template that was copied (7–40 hex). */
  templateRev?: string;
  /** `DATA_WORKER_HOST` — for the workers.dev diagnostic URL (#153). */
  dataWorkerHost?: string | undefined;
}

/**
 * Provision an app's DATA plane: D1 database + data worker + PAS app record.
 * Idempotent — an existing app is redeployed bound to its recorded D1 (#688), the
 * app record is an upsert that never rewrites a good id, and re-deploying the
 * (generic) data worker is harmless.
 *
 * Shared by `/v1/provision` (the CLI/SDK publish path) and `/v1/provision-data`
 * (the Agent Teams deploy stage, service-to-service) so a CLI-published app and
 * an agent-built app get the SAME data layer — closing the parity gap where
 * agent apps had no D1/data worker and `app.data` 404'd at runtime.
 */
export async function provisionData(
  args: ProvisionDataArgs,
): Promise<{ steps: Step[]; dataWorkerUrl: string; dbId: string }> {
  const { appId, creatorId, creatorLabel, cfToken, cfAccount, db, sessionSigningKey, internalToken, templateId, templateRev, dataWorkerHost } = args;
  const steps: Step[] = [];
  const claim = await appClaim(db, appId);
  if (claim?.retired || claim?.alias_reserved) {
    const detail = claim.retired ? 'app ID retired' : 'app ID reserved by canonical hostname';
    return { steps: [{ name: 'reserve_id', status: 'fail', detail }], dataWorkerUrl: '', dbId: '' };
  }

  // 1. Resolve the app's D1 database (#688).
  const dbName = `pas-data-${appId}`;
  let resolved: { dbId: string; step: Step };
  try {
    resolved = await resolveD1(db, appId, dbName, cfToken, cfAccount);
  } catch (e) {
    resolved = { dbId: '', step: { name: 'create_d1', status: 'fail', detail: String(e) } };
  }
  const { dbId } = resolved;
  steps.push(resolved.step);

  // 2. Deploy the data worker bound to that D1
  let dataWorkerUrl = '';
  if (dbId) {
    try {
      const result = await deployDataWorker(appId, dbId, cfToken, cfAccount, sessionSigningKey, internalToken ?? '', { dataWorkerHost });
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
  } else if (!(await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(creatorId).first())) {
    // SECURITY (#81): this internal endpoint writes creatorId as the app owner
    // AND the payout target (dev_profiles). Refuse an unknown creator so a
    // leaked INTERNAL_TOKEN can't forge ownership/payouts for an arbitrary id.
    steps.push({ name: 'record_app', status: 'fail', detail: `unknown creator: ${creatorId}` });
  } else {
    try {
      await db
        .prepare(
          `INSERT INTO apps (id, creator_id, d1_database_id, created_at, template_id, template_rev) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             d1_database_id = CASE WHEN apps.d1_database_id IS NULL OR apps.d1_database_id = '' THEN excluded.d1_database_id ELSE apps.d1_database_id END,
             template_id = COALESCE(apps.template_id, excluded.template_id),
             template_rev = COALESCE(apps.template_rev, excluded.template_rev)`,
        )
        .bind(appId, creatorId, dbId, Date.now(), templateId ?? null, templateRev ?? null)
        .run();
      // #178: the template + revision are recorded once (first provision wins) so a
      // re-provision can never rewrite the provenance of an existing app.
      steps.push({ name: 'record_app', status: 'ok', detail: `creator: ${creatorLabel ?? creatorId}${templateId ? `; template: ${templateId}@${templateRev ?? 'unknown'}` : ''}` });

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

const createD1Fail = (detail: string): { dbId: string; step: Step } => ({ dbId: '', step: { name: 'create_d1', status: 'fail', detail } });

/** The uuid of the account's database named exactly `dbName`, if any. */
async function namedD1(dbName: string, cfToken: string, cfAccount: string): Promise<string | undefined> {
  const listRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/d1/database?name=${dbName}`,
    { headers: { Authorization: `Bearer ${cfToken}` } },
  );
  const listData = (await listRes.json()) as { result?: { uuid: string; name: string }[] };
  return listData.result?.find((d) => d.name === dbName)?.uuid;
}

/**
 * #688: `apps.d1_database_id` is the authority for which database an app's data
 * worker binds; the name `pas-data-<appId>` only finds the database of an app
 * with no record yet. Every disagreement fails instead of guessing: binding by
 * name would hand a renamed app a fresh empty database (or another app's), and
 * binding the record over a differently-named live database would silently roll
 * the worker back to it. A failed step leaves the deployed worker untouched.
 */
async function resolveD1(db: D1Database, appId: string, dbName: string, cfToken: string, cfAccount: string): Promise<{ dbId: string; step: Step }> {
  const recorded = (await db.prepare('SELECT d1_database_id FROM apps WHERE id = ?').bind(appId).first<{ d1_database_id: string | null }>())?.d1_database_id;
  if (recorded) {
    // Never POST a create here: an existing app must keep its own database.
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/d1/database/${recorded}`, {
      headers: { Authorization: `Bearer ${cfToken}` },
    });
    if (res.status === 404) return createD1Fail(`recorded D1 ${recorded} not found; refusing to create an empty replacement`);
    const data = (await res.json()) as { success: boolean; errors?: { message: string }[] };
    if (!data.success) return createD1Fail(`recorded D1 ${recorded}: ${data.errors?.[0]?.message || 'unknown'}`);
    const named = await namedD1(dbName, cfToken, cfAccount);
    if (named && named !== recorded) {
      return createD1Fail(`${dbName} is ${named} but the app's recorded D1 is ${recorded}; refusing to bind either until an operator reconciles them`);
    }
    return { dbId: recorded, step: { name: 'create_d1', status: 'skip', detail: `${dbName} already exists (${recorded})` } };
  }

  const dbRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/d1/database`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: dbName }),
  });
  const dbData = (await dbRes.json()) as { success: boolean; result?: { uuid: string }; errors?: { message: string }[] };
  if (dbData.success && dbData.result) {
    return { dbId: dbData.result.uuid, step: { name: 'create_d1', status: 'ok', detail: `${dbName} (${dbData.result.uuid})` } };
  }
  const err = dbData.errors?.[0]?.message || 'unknown';
  if (!err.includes('already exists')) return createD1Fail(err);
  const existing = await namedD1(dbName, cfToken, cfAccount);
  if (!existing) return createD1Fail('exists per create but list returned nothing');
  // A database found by name may still be another app's (a retired ID's database
  // is recorded on the app it was renamed to): never bind it to a second app.
  const owner = await db.prepare('SELECT id FROM apps WHERE d1_database_id = ? AND id <> ?').bind(existing, appId).first<{ id: string }>();
  if (owner) return createD1Fail(`D1 ${existing} belongs to app ${owner.id}`);
  return { dbId: existing, step: { name: 'create_d1', status: 'skip', detail: `${dbName} already exists (${existing})` } };
}
