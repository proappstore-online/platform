/**
 * Run an app's `billing.authorize_action` for a buyer (#507). The app decides in its own SQL who may
 * buy what ("the buyer is a guardian of every child and the family is in paid mode"); the platform
 * only reads the verdict: exactly one row with `allowed = 1`. Anything else is a denial.
 *
 * The action must list "billing" in its callers (so users cannot call it directly and the worker
 * cannot be confused with it) and is a query. `:__user_id` is the buyer; `:product` and
 * `:subjects_json` (a JSON array of the opaque subject ids) are the only inputs. A data-worker
 * failure throws: checkout fails closed, and is not reported as a denial.
 */
import type { Env } from '../types.js';
import { actionCallers, prepareActionQuery } from './action-sql.js';
import { forwardToDataWorker, loadManifest } from '../routes/actions.js';

class BillingAuthorizeError extends Error {}

export async function runAuthorizeAction(
  env: Env, appId: string, action: string, userId: string, product: string, subjects: string[],
): Promise<boolean> {
  let manifest;
  try {
    manifest = await loadManifest(env.DB, appId, action);
  } catch {
    throw new BillingAuthorizeError(`authorize action "${action}" is not registered`);
  }
  if (manifest.operation !== 'query' || !actionCallers(manifest).includes('billing')) {
    throw new BillingAuthorizeError(`authorize action "${action}" must be a query action listing "billing" in its callers`);
  }
  const prepared = prepareActionQuery(manifest, { product, subjects_json: JSON.stringify(subjects) }, userId);
  const res = await forwardToDataWorker(env, appId, 'query', prepared, null);
  if (!res.ok) throw new BillingAuthorizeError(`authorize action "${action}" failed (${res.status})`);
  const body = await res.json().catch(() => null) as { rows?: unknown } | null;
  const rows = Array.isArray(body?.rows) ? body.rows as Record<string, unknown>[] : [];
  return rows.length === 1 && rows[0]?.allowed === 1;
}
