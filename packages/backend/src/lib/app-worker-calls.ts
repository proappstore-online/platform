/**
 * What an app worker can do through its `PAS` binding (#254, ADR-009 §2, §4),
 * as plain functions over Env so they are testable without RPC. The RPC surface
 * is rpc/app-worker-api.ts; it calls `authorizeWorkerCall` first, every time.
 *
 * Identity is `system:worker`: it matches no app user, so `:__user_id`-scoped
 * reads return nothing — worker tables use `auth.caller_unscoped` — and it never
 * satisfies a role gate. Only actions whose `callers` include "worker" run.
 *
 * Errors are thrown as `WorkerCallError` with a message `"<Code>: <detail>"`:
 * Workers RPC carries an error's message across the boundary, not its class.
 */
import type { Env } from '../types.js';
import { actionCallers, prepareActionBatch, prepareActionQuery, type ToolManifest } from './action-sql.js';
import { activeAppWorker } from './app-worker-host.js';
import { sha256Hex } from './app-tokens.js';
import { timingSafeEqual } from './bytes.js';
import { openAppSecret } from './app-secrets.js';
import { connectorConfigured, installationToken } from './github-app.js';
import { checkLogQuota, d1LogUsageStore } from './log-quota.js';
import { LEVELS, normalizeEntry } from './log-ingest.js';
import { HttpError } from './auth.js';
import { enforceActionAuth, forwardToDataWorker, loadManifest, recordActionSuccess } from '../routes/actions.js';
import { verifyCallerGrant } from './caller-grant.js';
import { fileQuotaRefusal } from '../routes/storage.js';

export const SYSTEM_WORKER_USER = 'system:worker';
/** ADR-009 §4: `PAS` calls per invocation, counted on the invocation record. */
export const MAX_PAS_CALLS_PER_INVOCATION = 200;
/** ADR-009 §4: prepared statements per `actions.batch` (half of D1's 1,000 per invocation). */
export const MAX_BATCH_STATEMENTS = 500;
export const MAX_BATCH_BODY_BYTES = 1024 * 1024;
export const MAX_WORKER_OBJECT_BYTES = 10 * 1024 * 1024;
const STORAGE_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,511}$/;

export type WorkerCallCode = 'Unauthorized' | 'TooManyCalls' | 'Forbidden' | 'NotFound' | 'BadRequest' | 'Unavailable' | 'Failed';

export class WorkerCallError extends Error {
  constructor(readonly code: WorkerCallCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'WorkerCallError';
  }
}

/** The second argument of every `PAS` call (ADR-009 §2). `as` is #260's caller grant. */
export interface CallCtx {
  token: string;
  /** `<envelope id>:<attempt>` — the app_worker_invocations row of the running invocation. */
  invocation: string;
  /** A caller grant from an http event (#260): run actions as that user. */
  as?: unknown;
}

/** The signed-in user a verified caller grant names (#260). */
export interface CallerIdentity { id: string; roles: string[] }

// ── Authorisation and budget ────────────────────────────────────────────────

const hexEqual = (a: string, b: string) => timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));

/**
 * Every `PAS` call, fail-closed (ADR-009 §2, §4): the app comes from the
 * binding's `props` only; the token must hash to the worker's current hash, or
 * to the previous one inside the rotation overlap; the worker must be enabled,
 * deployed and its app must exist; and the call is counted against the running
 * invocation's budget in one atomic UPDATE, so the cap holds across isolates.
 */
export async function authorizeWorkerCall(
  env: Pick<Env, 'DB' | 'SESSION_SIGNING_KEY'>, appId: string | undefined, ctx: unknown, now = Date.now(),
): Promise<{ caller: CallerIdentity | null }> {
  if (!appId) throw new WorkerCallError('Unauthorized', 'the binding carries no app');
  const call = ctx as Partial<CallCtx> | null;
  if (!call || typeof call.token !== 'string' || !call.token || typeof call.invocation !== 'string' || !call.invocation) {
    throw new WorkerCallError('Unauthorized', 'every PAS call needs { token, invocation }');
  }

  const w = await activeAppWorker(env, appId);
  const hash = await sha256Hex(call.token);
  const current = !!w?.token_hash && hexEqual(hash, w.token_hash);
  const previous = !!w?.prev_token_hash && !!w.prev_token_until && w.prev_token_until > now && hexEqual(hash, w.prev_token_hash);
  if (!w || !(current || previous)) throw new WorkerCallError('Unauthorized', 'invalid worker token for this app');
  // A caller grant (#260) must be one the platform signed for THIS app, unexpired.
  // Checked before the budget, so a forged or stale grant spends nothing.
  let caller: CallerIdentity | null = null;
  if (call.as !== undefined) {
    caller = await verifyCallerGrant(env, appId, call.as, Math.floor(now / 1000));
    if (!caller) throw new WorkerCallError('Unauthorized', 'invalid or expired caller grant');
  }

  const counted = await env.DB.prepare(
    `UPDATE app_worker_invocations SET pas_calls = pas_calls + 1
      WHERE id = ? AND app_id = ? AND status = 'running' AND pas_calls < ?`,
  ).bind(call.invocation, appId, MAX_PAS_CALLS_PER_INVOCATION).run();
  if (!counted.meta.changes) {
    const row = await env.DB.prepare('SELECT status FROM app_worker_invocations WHERE id = ? AND app_id = ?')
      .bind(call.invocation, appId).first<{ status: string }>();
    if (row?.status === 'running') throw new WorkerCallError('TooManyCalls', `at most ${MAX_PAS_CALLS_PER_INVOCATION} PAS calls per invocation`);
    throw new WorkerCallError('Unauthorized', 'PAS calls are accepted only during a running invocation');
  }
  return { caller };
}

/** One Analytics Engine point per call (ADR-009 §4); never fails the call. */
export function recordWorkerCall(env: Pick<Env, 'APP_WORKER_CALLS'>, appId: string, method: string, action: string, outcome: string): void {
  try {
    env.APP_WORKER_CALLS?.writeDataPoint({ indexes: [appId.slice(0, 96)], blobs: [method, action, outcome], doubles: [1] });
  } catch { /* telemetry never fails a call */ }
}

// ── actions ─────────────────────────────────────────────────────────────────

interface PreparedCall {
  name: string;
  endpoint: 'query' | 'execute' | 'batch';
  statements: { sql: string; params: unknown[] }[];
  /** The app role a caller-grant call ran under, for the success audit (#232). */
  role: string | null;
}

/**
 * The gate for one action. As `system:worker`: callers must include "worker",
 * no role gate. As a grant's user (#260): callers must include "user" and the
 * action's own role gates apply, exactly as on the HTTP actions route.
 */
async function prepareWorkerCall(
  env: Pick<Env, 'DB'>, appId: string, name: unknown, params: unknown, caller: CallerIdentity | null = null,
  manifests?: Map<string, Promise<ToolManifest>>,
): Promise<PreparedCall> {
  if (typeof name !== 'string' || !name) throw new WorkerCallError('BadRequest', 'action name is required');
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
    throw new WorkerCallError('BadRequest', `params of "${name}" must be an object`);
  }
  let manifest: ToolManifest;
  try {
    // A batch repeats one action hundreds of times: read each manifest once per batch (#312).
    let pending = manifests?.get(name);
    if (!pending) { pending = loadManifest(env.DB, appId, name); manifests?.set(name, pending); }
    manifest = await pending;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new WorkerCallError('NotFound', `action "${name}" is not registered`);
    throw e;
  }
  if (manifest.schedule !== undefined) throw new WorkerCallError('Forbidden', `"${name}" is a scheduled action; only the platform scheduler runs it`);
  let role: string | null = null;
  if (caller) {
    if (!actionCallers(manifest).includes('user')) throw new WorkerCallError('Forbidden', `"${name}" does not list "user" in its callers`);
    // A grant carries no sign-in time, so it can never satisfy a step-up.
    if (manifest.step_up) throw new WorkerCallError('Forbidden', `"${name}" needs a recent sign-in, which a worker request cannot carry`);
    try {
      role = await enforceActionAuth(env.DB, appId, manifest, { id: caller.id, login: caller.id, avatarUrl: null, roles: caller.roles });
    } catch (e) {
      if (e instanceof HttpError) throw new WorkerCallError('Forbidden', `"${name}": ${e.message}`);
      throw e;
    }
  } else {
    if (!actionCallers(manifest).includes('worker')) throw new WorkerCallError('Forbidden', `"${name}" does not list "worker" in its callers`);
    if (manifest.auth?.app_roles?.length || manifest.auth?.platform_roles?.length) {
      throw new WorkerCallError('Forbidden', `"${name}" is role-gated; system:worker holds no role`);
    }
  }
  const input = (params ?? {}) as Record<string, unknown>;
  const userId = caller?.id ?? SYSTEM_WORKER_USER;
  try {
    switch (manifest.operation) {
      case 'query':
      case 'execute':
        return { name, endpoint: manifest.operation, statements: [prepareActionQuery(manifest, input, userId)], role };
      case 'batch':
        return { name, endpoint: 'batch', statements: prepareActionBatch(manifest, input, userId), role };
      default:
        throw new WorkerCallError('Forbidden', `"${name}" is a ${manifest.operation} action, which workers cannot run`);
    }
  } catch (e) {
    if (e instanceof WorkerCallError) throw e;
    throw new WorkerCallError('BadRequest', `"${name}": ${(e as Error).message}`);
  }
}

async function dataWorker(env: Env, appId: string, endpoint: string, payload: unknown): Promise<unknown> {
  const res = await forwardToDataWorker(env, appId, endpoint, payload, null);
  const text = await res.text();
  if (!res.ok) throw new WorkerCallError(res.status >= 500 ? 'Failed' : 'BadRequest', `data worker ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkerCallError('Failed', 'the data worker returned an invalid response');
  }
}

/** Run one registered action as `system:worker`. Returns the data worker's answer (`rows`/`meta`, or `results` for a batch tool). */
export async function workerActionCall(env: Env, appId: string, name: unknown, params: unknown, caller: CallerIdentity | null = null): Promise<unknown> {
  const call = await prepareWorkerCall(env, appId, name, params, caller);
  const payload = call.endpoint === 'batch' ? { statements: call.statements } : call.statements[0];
  const answer = await dataWorker(env, appId, call.endpoint, payload);
  await auditAsUser(env, appId, [call], caller);
  return answer;
}

/** The role-gated success audit (#232) for actions a grant's user ran — as the HTTP route records it. */
async function auditAsUser(env: Env, appId: string, calls: PreparedCall[], caller: CallerIdentity | null): Promise<void> {
  if (!caller) return;
  for (const c of calls) if (c.role) await recordActionSuccess(env.DB, appId, c.name, { actorId: caller.id, role: c.role }, 200);
}

/**
 * Run many action invocations in ONE data-worker `/batch` — one D1 transaction,
 * all or nothing. At most `MAX_BATCH_STATEMENTS` prepared statements and
 * `MAX_BATCH_BODY_BYTES`, checked before any SQL runs. Returns, per call, the
 * results of its statements.
 */
export async function workerActionBatch(env: Env, appId: string, calls: unknown, caller: CallerIdentity | null = null): Promise<{ name: string; results: unknown[] }[]> {
  if (!Array.isArray(calls) || calls.length === 0) throw new WorkerCallError('BadRequest', 'batch takes a non-empty array of { name, params }');
  const prepared: PreparedCall[] = [];
  const manifests = new Map<string, Promise<ToolManifest>>();
  let count = 0;
  for (const c of calls as { name?: unknown; params?: unknown }[]) {
    const p = await prepareWorkerCall(env, appId, c?.name, c?.params, caller, manifests);
    count += p.statements.length;
    if (count > MAX_BATCH_STATEMENTS) throw new WorkerCallError('BadRequest', `a batch runs at most ${MAX_BATCH_STATEMENTS} prepared statements`);
    prepared.push(p);
  }
  const statements = prepared.flatMap((p) => p.statements);
  const payload = { statements };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_BATCH_BODY_BYTES) {
    throw new WorkerCallError('BadRequest', `a batch body is at most ${MAX_BATCH_BODY_BYTES} bytes`);
  }
  const answer = await dataWorker(env, appId, 'batch', payload) as { results?: unknown[] };
  await auditAsUser(env, appId, prepared, caller);
  const results = answer.results ?? [];
  let at = 0;
  return prepared.map((p) => {
    const mine = results.slice(at, at + p.statements.length);
    at += p.statements.length;
    return { name: p.name, results: mine };
  });
}

// ── secrets ─────────────────────────────────────────────────────────────────

/**
 * An app secret the manifest's `worker.secrets` declares, decrypted; null for an
 * undeclared or missing name, so a removed secret degrades instead of failing
 * the worker. Never logged.
 */
export async function workerSecretGet(env: Env, appId: string, name: unknown): Promise<string | null> {
  if (typeof name !== 'string' || !name) throw new WorkerCallError('BadRequest', 'secret name is required');
  const row = await env.DB.prepare('SELECT secrets FROM app_worker_manifest WHERE app_id = ?').bind(appId).first<{ secrets: string }>();
  let declared: unknown = [];
  try { declared = JSON.parse(row?.secrets ?? '[]'); } catch { /* corrupt: declares nothing */ }
  if (!Array.isArray(declared) || !declared.includes(name)) {
    console.warn(`[app-worker] ${appId} asked for secret "${name}", which its manifest's worker.secrets does not declare`);
    return null;
  }
  if (!env.APP_SECRET_KEK) throw new WorkerCallError('Unavailable', 'app secrets are not configured on this deployment');
  return openAppSecret(env, env.APP_SECRET_KEK, appId, name);
}

// ── connectors ──────────────────────────────────────────────────────────────

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * A GitHub credential for the worker (#258 §4): an installation token covering `repo`'s
 * owner (repo-scoped when `repo` is given — GitHub enforces it), else the owner's PAT
 * secret, else null. `mode: 'pat'` forces the PAT (an installation token cannot answer
 * `viewer` / `@me`); `mode: 'app'` never falls back to it. Only for a connector the app's
 * manifest declares. Never logged.
 */
export async function workerConnectorToken(env: Env, appId: string, name: unknown, opts: unknown): Promise<string | null> {
  if (typeof name !== 'string' || !name) throw new WorkerCallError('BadRequest', 'connector name is required');
  const o = (opts ?? {}) as { repo?: unknown; mode?: unknown };
  if (typeof o !== 'object' || Array.isArray(o)) throw new WorkerCallError('BadRequest', 'options must be an object');
  if (o.repo !== undefined && (typeof o.repo !== 'string' || !REPO_RE.test(o.repo))) throw new WorkerCallError('BadRequest', 'repo must be "owner/name"');
  if (o.mode !== undefined && o.mode !== 'app' && o.mode !== 'pat') throw new WorkerCallError('BadRequest', 'mode must be "app" or "pat"');
  const repo = o.repo as string | undefined;
  const mode = o.mode as 'app' | 'pat' | undefined;

  const connector = await env.DB.prepare("SELECT modes, pat_secret FROM app_connectors WHERE app_id = ? AND name = ? AND kind = 'github'")
    .bind(appId, name).first<{ modes: string; pat_secret: string | null }>();
  if (!connector) {
    console.warn(`[app-worker] ${appId} asked for connector "${name}", which its manifest does not declare`);
    return null;
  }
  const modes = JSON.parse(connector.modes) as string[];

  if (mode !== 'pat' && modes.includes('app') && connectorConfigured(env)) {
    // An installation covers the owner; without a repo there is no owner, so the app's earliest binding.
    const owner = repo?.split('/')[0]!.toLowerCase();
    const installation = await env.DB.prepare(
      `SELECT installation_id FROM app_connector_installations WHERE app_id = ? AND connector = 'github'${owner ? ' AND lower(account_login) = ?' : ''} ORDER BY created_at LIMIT 1`,
    ).bind(appId, ...(owner ? [owner] : [])).first<{ installation_id: number }>();
    if (installation) {
      const token = await installationToken(env, installation.installation_id, repo).catch(() => null);
      if (token) return token;
    }
  }
  if (mode === 'app' || !modes.includes('pat') || !connector.pat_secret) return null;
  if (!env.APP_SECRET_KEK) throw new WorkerCallError('Unavailable', 'app secrets are not configured on this deployment');
  return openAppSecret(env, env.APP_SECRET_KEK, appId, connector.pat_secret);
}

// ── storage ─────────────────────────────────────────────────────────────────

/** `${appId}/_worker/<key>`: the worker's own namespace, never a user's prefix (ADR-009 §2). */
export function workerStorageKey(appId: string, key: unknown): string {
  if (typeof key !== 'string' || !STORAGE_KEY.test(key) || key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new WorkerCallError('BadRequest', 'storage key must be a relative path of [A-Za-z0-9_.-/] (max 512 chars)');
  }
  return `${appId}/_worker/${key}`;
}

export async function workerStoragePut(env: Env, appId: string, key: unknown, body: unknown, opts?: { contentType?: unknown }): Promise<{ key: string; size: number }> {
  const objectKey = workerStorageKey(appId, key);
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body)
    : body instanceof ArrayBuffer ? new Uint8Array(body)
      : body instanceof Uint8Array ? body : null;
  if (!bytes) throw new WorkerCallError('BadRequest', 'storage body must be a string, ArrayBuffer or Uint8Array');
  if (bytes.byteLength > MAX_WORKER_OBJECT_BYTES) throw new WorkerCallError('BadRequest', `storage objects are at most ${MAX_WORKER_OBJECT_BYTES} bytes`);
  const refusal = await fileQuotaRefusal(env.STORAGE, objectKey, `${appId}/_worker/`);
  if (refusal) throw new WorkerCallError('BadRequest', refusal);
  const contentType = typeof opts?.contentType === 'string' && opts.contentType.length <= 200 ? opts.contentType : 'application/octet-stream';
  await env.STORAGE.put(objectKey, bytes, { httpMetadata: { contentType } });
  return { key: key as string, size: bytes.byteLength };
}

export async function workerStorageGet(env: Env, appId: string, key: unknown): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const object = await env.STORAGE.get(workerStorageKey(appId, key));
  if (!object) return null;
  return { body: await object.arrayBuffer(), contentType: object.httpMetadata?.contentType ?? 'application/octet-stream' };
}

// ── log ─────────────────────────────────────────────────────────────────────

/** Append to the app's logs as `system:worker`, category `worker`, within the app's log quota. Returns whether it was stored. */
export async function workerLog(env: Env, appId: string, level: unknown, message: unknown, fields: unknown): Promise<boolean> {
  if (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level)) throw new WorkerCallError('BadRequest', `level must be one of ${LEVELS.join(', ')}`);
  const now = Date.now();
  const entry = await normalizeEntry({ level, category: 'worker', message, ...(fields !== undefined ? { data: fields } : {}) }, now);
  if (!entry) throw new WorkerCallError('BadRequest', 'message must be a non-empty string');
  const verdict = await checkLogQuota(d1LogUsageStore(env.DB), { appId, clientKey: 'app-worker', entries: 1, nowMs: now });
  if (!verdict.persist) return false;
  await env.DB.prepare(
    `INSERT INTO app_logs (app_id, user_id, client_id, ts, level, category, message, data, build_meta, fingerprint, trace_id, source, ingested_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, 'worker', ?)`,
  ).bind(appId, SYSTEM_WORKER_USER, entry.ts, entry.level, entry.category, entry.message, entry.data, entry.fingerprint, now).run();
  return true;
}
