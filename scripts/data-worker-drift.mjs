#!/usr/bin/env node
/**
 * Report data workers that no app owns (#446).
 *
 * Every fleet operation (redeploy-data-workers.yml, the #394 observability rollout) iterates the
 * `apps` registry, so a `pas-data-<id>` worker with no `apps` row is never touched and drifts
 * silently. This lists the account's workers and diffs them against the registry.
 *
 * Usage (CI: .github/workflows/reconcile-data-workers.yml):
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/data-worker-drift.mjs <apps.json>
 *   <apps.json> is `[{ "id": "…" }, …]`, the registry (wrangler d1 execute … --json, flattened).
 * Exit 1 when any orphan exists. DATA_WORKER_ALLOWLIST (comma-separated app ids) acknowledges a
 * deliberate exception without hiding new drift.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DATA_WORKER_PREFIX = 'pas-data-';

/** App ids that have a `pas-data-<id>` worker but no registry row. Sorted; allowlisted ids are skipped. */
export function findOrphanDataWorkers(scriptNames, registeredIds, allowlist = []) {
  const registered = new Set(registeredIds);
  const allowed = new Set(allowlist);
  return scriptNames
    .filter((name) => name.startsWith(DATA_WORKER_PREFIX))
    .map((name) => name.slice(DATA_WORKER_PREFIX.length))
    .filter((id) => id && !registered.has(id) && !allowed.has(id))
    .sort();
}

async function listWorkerScripts(accountId, token) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!res.ok || body.success === false) throw new Error(`Cloudflare worker list failed (HTTP ${res.status}): ${JSON.stringify(body.errors ?? body)}`);
  return body.result.map((s) => s.id);
}

async function main() {
  const [registryFile] = process.argv.slice(2);
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
  if (!registryFile || !token || !account) {
    console.error('usage: CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/data-worker-drift.mjs <apps.json>');
    process.exit(2);
  }
  const registered = JSON.parse(readFileSync(registryFile, 'utf8')).map((a) => a.id);
  const allowlist = (process.env.DATA_WORKER_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const orphans = findOrphanDataWorkers(await listWorkerScripts(account, token), registered, allowlist);
  if (!orphans.length) {
    console.log(`✓ every pas-data-* worker has an apps row (${registered.length} registered)`);
    return;
  }
  for (const id of orphans) {
    console.error(`::error::${DATA_WORKER_PREFIX}${id} has no apps row: fleet rollouts skip it. Register it (redeploy-data-workers.yml with app_id=${id} and creator_id) or delete the worker.`);
  }
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
