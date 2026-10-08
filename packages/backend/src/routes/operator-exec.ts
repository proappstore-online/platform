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
import { unguardedStatements } from '../lib/operator-contract.js';
import { gatedTool } from '../lib/operator-contract-shared.js';

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
  const read = await startOperatorQuery(env, appId, name, input, user, token, audit);
  await read.finish(200);
  return read.rows;
}

/**
 * runOperatorQuery for a read whose outcome is only known after the query
 * (#345): the evidence route still has to find the document and check its type.
 * `finish(status)` writes the role-granted audit row with that final status, so
 * a failed download is never recorded as a 200.
 */
export async function startOperatorQuery(
  env: Env,
  appId: string,
  name: string,
  input: Record<string, unknown>,
  user: FasUser,
  token: string,
  audit: OperatorAudit,
): Promise<{ rows: Record<string, unknown>[]; finish: (status: number) => Promise<void> }> {
  const { body, role } = await runOperatorCall(env, appId, name, input, user, token, ['query']);
  const rows = (body as { rows?: unknown }).rows;
  return {
    rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
    finish: async (status) => {
      if (role) { await recordActionSuccess(env.DB, appId, name, { actorId: user.id, role }, status, audit); markAudited(audit.request); }
    },
  };
}

/**
 * Run a registered write (execute or batch) for an operator-view action (#240)
 * under the same gates as the actions route, and return how many rows it
 * changed. With `guard` (a status transition: the param carrying the row's
 * status), every statement must use that param, re-checked here against the
 * action as registered now (#340), so a stale status changes nothing anywhere
 * in the batch. A write the guard matched to nothing is recorded with status
 * 409 and refused: the record moved on since the operator loaded it.
 */
export async function runOperatorWrite(
  env: Env,
  appId: string,
  name: string,
  input: Record<string, unknown>,
  user: FasUser,
  token: string,
  audit: OperatorAudit,
  guard: string | null,
): Promise<number> {
  const { body, role } = await runOperatorCall(env, appId, name, input, user, token, ['execute', 'batch'], guard);
  const result = body as { meta?: { changes?: unknown }; results?: { meta?: { changes?: unknown } }[] };
  const changes = Array.isArray(result.results)
    ? result.results.reduce((n, r) => n + Number(r.meta?.changes ?? 0), 0)
    : Number(result.meta?.changes ?? 0);
  const refused = guard !== null && changes === 0;
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
  guard: string | null = null,
): Promise<{ body: unknown; role: string | null }> {
  const manifest = await loadManifest(env.DB, appId, name);
  // The console runs actions as the owner: a worker/hook-only action (#254) is out of reach, like a scheduled one.
  if (!operations.includes(manifest.operation) || manifest.requires_auth === false || manifest.schedule !== undefined || !actionCallers(manifest).includes('user')) {
    throw new HttpError(`action ${name} cannot run from the operator view`, 409);
  }
  // The operator view runs only role-gated actions (#348), re-checked against the
  // action as registered now: a same-named action re-registered without a role
  // would otherwise run for any admitted caller and write no audit row.
  const ungated = gatedTool([manifest], manifest.name, 'operator view');
  if (typeof ungated === 'string') throw new HttpError(`${ungated}; the operator view refuses it until it is redeployed with a role`, 409);
  // A contract stored before #340, or an action re-registered since, may have a
  // statement that ignores the status: it would commit even when the guard fails.
  if (guard !== null && unguardedStatements(manifest, guard).length) {
    throw new HttpError(`action ${name} does not guard every statement with :${guard}; redeploy it so each statement checks the status`, 409);
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
