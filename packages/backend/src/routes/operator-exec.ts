/**
 * The console operator view's executor (#240): runs an app's registered query
 * or write for the owner-only operator routes under exactly the gates of
 * POST /apps/:appId/actions/:name — the action's platform/app role check from
 * D1, then step_up — and writes the success audit with the operator context.
 * App ownership (checked by the operator route) grants nothing here.
 */
import type { Env } from '../types.js';
import { HttpError, requireRecentAuth, type FasUser } from '../lib/auth.js';
import { actionCallers, prepareActionBatch, prepareActionQuery, type ToolManifest } from '../lib/action-sql.js';
import { enforceActionAuth, forwardToDataWorker, loadManifest, recordActionSuccess } from './actions.js';
import { markAudited } from '../lib/operator-audit-marks.js';
import { CONSOLE_RP_ID } from './passkeys.js';

/** What an operator-view call adds to its audit row (#240): the contract action or read, and its target record. */
export interface OperatorAudit {
  operatorAction: string;
  target: string | null;
  /** The operator request: marked once its audit row is written, so a later refusal is not recorded twice. */
  request: Request;
}

/**
 * Run one of an app's registered query actions for the console operator view
 * (#240) and return its rows. The same gates as POST /apps/:appId/actions/:name
 * for a session caller — platform/app role check from D1, then step_up — and a
 * role-granted success is audited the same way. The caller's app ownership is
 * checked by the operator route before this runs; ownership grants nothing here.
 */
export async function runOperatorQuery(
  env: Env,
  appId: string,
  name: string,
  input: Record<string, unknown>,
  user: FasUser,
  token: string,
  audit: OperatorAudit,
): Promise<Record<string, unknown>[]> {
  const { body, role } = await runOperatorCall(env, appId, name, input, user, token, ['query']);
  if (role) { await recordActionSuccess(env.DB, appId, name, { actorId: user.id, role }, 200, audit); markAudited(audit.request); }
  const rows = (body as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * Run a registered write (execute or batch) for an operator-view action (#240)
 * under the same gates as the actions route, and return how many rows it
 * changed. With `mustChange` (a status transition), a write the app's SQL guard
 * matched to nothing is recorded with status 409 and refused: the record moved
 * on since the operator loaded it.
 */
export async function runOperatorWrite(
  env: Env,
  appId: string,
  name: string,
  input: Record<string, unknown>,
  user: FasUser,
  token: string,
  audit: OperatorAudit,
  mustChange: boolean,
): Promise<number> {
  const { body, role } = await runOperatorCall(env, appId, name, input, user, token, ['execute', 'batch']);
  const result = body as { meta?: { changes?: unknown }; results?: { meta?: { changes?: unknown } }[] };
  const changes = Array.isArray(result.results)
    ? result.results.reduce((n, r) => n + Number(r.meta?.changes ?? 0), 0)
    : Number(result.meta?.changes ?? 0);
  const refused = mustChange && changes === 0;
  if (role) { await recordActionSuccess(env.DB, appId, name, { actorId: user.id, role }, refused ? 409 : 200, audit); markAudited(audit.request); }
  if (refused) throw new HttpError('the record changed since it was loaded; reload and try again', 409);
  return changes;
}

async function runOperatorCall(
  env: Env,
  appId: string,
  name: string,
  input: Record<string, unknown>,
  user: FasUser,
  token: string,
  operations: ToolManifest['operation'][],
): Promise<{ body: unknown; role: string | null }> {
  const manifest = await loadManifest(env.DB, appId, name);
  // The console runs actions as the owner: a worker/hook-only action (#254) is out of reach, like a scheduled one.
  if (!operations.includes(manifest.operation) || manifest.requires_auth === false || manifest.schedule !== undefined || !actionCallers(manifest).includes('user')) {
    throw new HttpError(`action ${name} cannot run from the operator view`, 409);
  }
  const role = await enforceActionAuth(env.DB, appId, manifest, user);
  if (manifest.step_up) requireRecentAuth(user, env, { rpId: CONSOLE_RP_ID });
  let endpoint: string;
  let payload: unknown;
  try {
    endpoint = manifest.operation === 'batch' ? 'batch' : manifest.operation;
    payload = manifest.operation === 'batch'
      ? { statements: prepareActionBatch(manifest, input, user.id) }
      : prepareActionQuery(manifest, input, user.id);
  } catch (e) {
    throw new HttpError(e instanceof Error ? e.message : String(e), 400);
  }
  const upstream = await forwardToDataWorker(env, appId, endpoint, payload, token);
  const text = await upstream.text();
  if (!upstream.ok) throw new HttpError(`action ${name} failed (${upstream.status})`, upstream.status >= 500 ? 502 : upstream.status);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError('data worker returned an invalid response', 502);
  }
  return { body, role };
}
