/**
 * App workers (#253, ADR-009): per-app server code the platform deploys and
 * invokes. One `AppWorkerHost` interface, three backends chosen by
 * `APP_WORKER_BACKEND` (ADR-009 §5):
 *
 *   loader   — Dynamic Workers (`env.LOADER`). Implemented. The bundle lives in R2
 *              and is loaded on demand with the platform shim as main module, no
 *              Internet egress (`globalOutbound: null`) and explicit CPU and
 *              subrequest limits. No account script, no public URL.
 *   account  — plain `pas-app-<id>` scripts. Not implemented: kept as the
 *              fallback if the loader cannot carry the prototype.
 *   dispatch — Workers for Platforms. Not implemented (#267).
 *   unset    — app workers are off: deploy and invoke answer 503.
 *
 * On every backend `remove()` works, because revoking a worker's credentials
 * and deleting its code must never depend on the backend being configured.
 *
 * Common to every backend: the signed event envelope (app-worker-shim/signature.ts),
 * the per-app token and event key (minted on first deploy, stored hashed and
 * sealed under APP_SECRET_KEK, rotated with a 10-minute overlap), the bundle
 * rules, and one `app_worker_invocations` row per invocation.
 */
import type { Env } from '../types.js';
import { HttpError } from './auth.js';
import { openSecret, sealSecret, type SealedSecret } from './encryption.js';
import { sha256Hex } from './app-tokens.js';
import { toUint8 } from './bytes.js';
import { checkLogQuota, d1LogUsageStore } from './log-quota.js';
import { SIGNATURE_HEADER, signatureHeader } from '../app-worker-shim/signature.js';
import { APP_WORKER_SHIM } from '../generated/app-worker-shim.js';

export type AppWorkerBackend = 'account' | 'loader' | 'dispatch';

export const SHIM_MODULE = '__pas_entry.js';
export const APP_MODULE = 'app.js';
/** ADR-009: ≤ 3 MB compressed. Checked on the uncompressed size, which is stricter. */
export const MAX_BUNDLE_BYTES = 3 * 1024 * 1024;
export const MAX_BUNDLE_MODULES = 50;
/** Bundles kept in R2 per app: the deployed one and the two before it. */
export const KEPT_BUNDLES = 3;
export const ROTATION_OVERLAP_MS = 10 * 60 * 1000;
/** The first bytes of a non-2xx response kept on the invocation record. */
export const BODY_EXCERPT_BYTES = 1024;
/** ADR-009 §5: at most 4 Dynamic Workers in flight per request. Callers that fan out (#255, #257) stay under it. */
export const LOADER_MAX_CONCURRENT = 4;
/** Platform-pinned, as for data workers (lib/deploy-worker.ts); `env.APP_WORKER_COMPATIBILITY_DATE` overrides it. */
export const APP_WORKER_COMPATIBILITY_DATE = '2026-01-01';
const compatibilityDate = (env: Pick<Env, 'APP_WORKER_COMPATIBILITY_DATE'>) => env.APP_WORKER_COMPATIBILITY_DATE ?? APP_WORKER_COMPATIBILITY_DATE;
const COMPATIBILITY_FLAGS = ['nodejs_compat'];
/**
 * ADR-009 §4: 30 s CPU per invocation. `subRequests` is the 200-call `PAS`
 * budget only: the worker has no egress yet (`globalOutbound: null`), so there
 * is no outbound budget to add. #267 sizes it when the egress gateway lands.
 */
export const APP_WORKER_LIMITS = { cpuMs: 30_000, subRequests: 200 } as const;

const R2_PREFIX = '_app-workers';
const MODULE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.\/-]{0,199}\.m?js$/;

export interface WorkerBundle {
  /** Module name → ES module source. Must contain `app.js`. */
  modules: Record<string, string>;
}

export interface DeployResult {
  backend: AppWorkerBackend;
  bundleSha256: string;
  /** True when this deploy minted the worker's token and event key. */
  firstDeploy: boolean;
}

export interface AppWorkerEvent {
  /** Envelope id: the idempotency key, stable across retries. */
  id: string;
  type: 'schedule' | 'hook' | 'http';
  name?: string;
  attempt: number;
  payload: unknown;
  /** `http` events only (#260). */
  caller?: unknown;
}

export interface InvokeResult {
  invocationId: string;
  status: 'succeeded' | 'failed' | 'timeout';
  httpStatus: number | null;
  /** The worker's response body (full on success; the record keeps only an excerpt on failure). */
  body: string | null;
}

export interface AppWorkerHost {
  readonly backend: AppWorkerBackend | null;
  deploy(appId: string, bundle: WorkerBundle, source?: { sha?: string | undefined; ref?: string | undefined }): Promise<DeployResult>;
  invoke(appId: string, event: AppWorkerEvent, opts: { timeoutMs: number }): Promise<InvokeResult>;
  remove(appId: string): Promise<void>;
}

/**
 * Where the `PAS` stub comes from (#254): the calling Worker's own
 * `ctx.exports.AppWorkerApi`, so its `props` are set by platform code and cannot
 * be forged by the app (ADR-009 §2).
 */
export interface AppWorkerExports {
  exports?: { AppWorkerApi?: (opts: { props: { appId: string } }) => unknown };
}

/**
 * The host for this deployment's backend. Never throws; an unusable backend
 * answers on use. Pass the request's ExecutionContext so invoked workers get
 * their `PAS` binding; without it they run with no `PAS`.
 */
export function appWorkerHost(env: Env, ctx?: AppWorkerExports): AppWorkerHost {
  switch (env.APP_WORKER_BACKEND) {
    case 'loader':
      return env.LOADER ? loaderHost(env, env.LOADER, ctx) : unavailableHost(env, 'loader', 'the LOADER binding is missing', 503);
    case 'account':
    case 'dispatch':
      return unavailableHost(env, env.APP_WORKER_BACKEND, `the ${env.APP_WORKER_BACKEND} app-worker backend is not implemented`, 501);
    default:
      return unavailableHost(env, null, 'app workers are not configured on this deployment', 503);
  }
}

// ── The app_workers row ─────────────────────────────────────────────────────

export interface AppWorkerRow {
  app_id: string;
  enabled: number;
  backend: string | null;
  token_hash: string | null;
  token_ct: unknown; token_dek: unknown; token_iv: unknown;
  prev_token_hash: string | null; prev_token_until: number | null;
  config_version: number;
  event_key_ct: unknown; event_key_dek: unknown; event_key_iv: unknown;
  prev_event_key_ct: unknown; prev_event_key_dek: unknown; prev_event_key_iv: unknown; prev_key_until: number | null;
  bundle_sha256: string | null;
  deployed_at: number | null;
}

/**
 * The app's worker if it may run: enabled, deployed, and its app still exists.
 * Every caller that runs app workers — the scheduler (#255), hooks (#256), the
 * GitHub demux (#258), browser routes (#260) and `invoke` — goes through this,
 * so an orphaned or disabled row never runs.
 */
export async function activeAppWorker(env: Pick<Env, 'DB'>, appId: string): Promise<AppWorkerRow | null> {
  return env.DB.prepare(
    `SELECT w.* FROM app_workers w INNER JOIN apps a ON a.id = w.app_id
      WHERE w.app_id = ? AND w.enabled = 1 AND w.deployed_at IS NOT NULL`,
  ).bind(appId).first<AppWorkerRow>();
}

// ── Bundles ─────────────────────────────────────────────────────────────────

/**
 * A deploy request's multipart body as a bundle, or a 400. Every part must be a
 * file named like an ES module. The platform's own entry module, wrangler
 * config and metadata parts are refused: the platform alone decides the entry
 * point and the bindings (ADR-009 §1).
 */
export async function parseBundle(form: FormData): Promise<WorkerBundle> {
  const modules: Record<string, string> = {};
  let total = 0;
  for (const [name, entry] of form.entries()) {
    const value = entry as string | File;
    if (name === SHIM_MODULE) throw new HttpError(`${SHIM_MODULE} is the platform's entry module and cannot be uploaded`, 400);
    if (/^wrangler\./i.test(name) || name === 'metadata') throw new HttpError(`part "${name}" is not allowed: the platform builds the worker's configuration`, 400);
    if (typeof value === 'string') throw new HttpError(`part "${name}" must be a file`, 400);
    if (!MODULE_NAME.test(name) || name.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
      throw new HttpError(`part "${name}" is not a valid module name (expected a relative .js/.mjs path)`, 400);
    }
    if (name in modules) throw new HttpError(`part "${name}" is uploaded twice`, 400);
    const text = await value.text();
    total += new TextEncoder().encode(text).byteLength;
    if (total > MAX_BUNDLE_BYTES) throw new HttpError(`bundle exceeds ${MAX_BUNDLE_BYTES} bytes`, 400);
    modules[name] = text;
  }
  if (!(APP_MODULE in modules)) throw new HttpError(`bundle must contain ${APP_MODULE} (the app worker entry)`, 400);
  if (Object.keys(modules).length > MAX_BUNDLE_MODULES) throw new HttpError(`bundle has more than ${MAX_BUNDLE_MODULES} modules`, 400);
  return { modules };
}

/** A stable hash of the whole bundle: names and sources, in name order. */
export async function bundleSha256(bundle: WorkerBundle): Promise<string> {
  const names = Object.keys(bundle.modules).sort();
  return sha256Hex(names.map((n) => `${n}\u0000${bundle.modules[n]!.length}\u0000${bundle.modules[n]}`).join('\u0000'));
}

const bundlePrefix = (appId: string) => `${R2_PREFIX}/${appId}/`;

async function storeBundle(storage: R2Bucket, appId: string, sha: string, bundle: WorkerBundle): Promise<void> {
  await Promise.all(Object.entries(bundle.modules).map(([name, source]) =>
    storage.put(`${bundlePrefix(appId)}${sha}/${name}`, source, { httpMetadata: { contentType: 'application/javascript' } })));
}

async function loadBundle(storage: R2Bucket, appId: string, sha: string): Promise<Record<string, string>> {
  const prefix = `${bundlePrefix(appId)}${sha}/`;
  const modules: Record<string, string> = {};
  for (const obj of await listAll(storage, prefix)) {
    const body = await storage.get(obj.key);
    if (body) modules[obj.key.slice(prefix.length)] = await body.text();
  }
  if (!(APP_MODULE in modules)) throw new Error(`app worker bundle ${sha} for ${appId} is missing from storage`);
  return modules;
}

/** Delete every stored bundle but the newest `KEPT_BUNDLES`, never the deployed one. */
async function pruneBundles(storage: R2Bucket, appId: string, keep: string): Promise<void> {
  const prefix = bundlePrefix(appId);
  const newest = new Map<string, number>();
  const objects = await listAll(storage, prefix);
  for (const obj of objects) {
    const sha = obj.key.slice(prefix.length).split('/')[0]!;
    newest.set(sha, Math.max(newest.get(sha) ?? 0, obj.uploaded.getTime()));
  }
  const kept = new Set([keep, ...[...newest.entries()].sort((a, b) => b[1] - a[1]).map(([sha]) => sha).slice(0, KEPT_BUNDLES)]);
  const stale = objects.filter((o) => !kept.has(o.key.slice(prefix.length).split('/')[0]!)).map((o) => o.key);
  if (stale.length) await storage.delete(stale);
}

async function listAll(storage: R2Bucket, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.list({ prefix, ...(cursor ? { cursor } : {}) });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// ── Credentials ─────────────────────────────────────────────────────────────

function kekOf(env: Pick<Env, 'APP_SECRET_KEK'>): string {
  if (!env.APP_SECRET_KEK) throw new HttpError('app workers need APP_SECRET_KEK to seal their credentials', 503);
  return env.APP_SECRET_KEK;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface MintedCredentials { tokenHash: string; token: SealedSecret; eventKey: SealedSecret }

/** A fresh PAS_WORKER_TOKEN and PAS_EVENT_KEY, hashed and sealed. The plaintext leaves this function only sealed. */
async function mintCredentials(kek: string): Promise<MintedCredentials> {
  const token = randomHex(32);
  return { tokenHash: await sha256Hex(token), token: await sealSecret(token, kek), eventKey: await sealSecret(randomHex(32), kek) };
}

const sealed = (ct: unknown, dek: unknown, iv: unknown): SealedSecret => ({ keyCiphertext: toUint8(ct), dekWrapped: toUint8(dek), iv: toUint8(iv) });

/**
 * Rotate the worker's token and event key (ADR-009 §2–3). One statement: the
 * current credentials move to `prev_*` for `ROTATION_OVERLAP_MS`, so in-flight
 * invocations and `PAS` calls holding the old token are not dropped, and
 * `config_version` bumps so the loader starts a new isolate with the new env.
 * Refused (409) for a worker that has never been deployed.
 */
export async function rotateAppWorkerCredentials(env: Pick<Env, 'DB' | 'APP_SECRET_KEK'>, appId: string, now = Date.now()): Promise<{ configVersion: number }> {
  const kek = kekOf(env);
  const row = await env.DB.prepare('SELECT token_hash FROM app_workers WHERE app_id = ?').bind(appId).first<{ token_hash: string | null }>();
  if (!row?.token_hash) throw new HttpError('this app worker has not been deployed; there is nothing to rotate', 409);
  const next = await mintCredentials(kek);
  const until = now + ROTATION_OVERLAP_MS;
  const updated = await env.DB.prepare(
    `UPDATE app_workers SET
       prev_token_hash = token_hash, prev_token_until = ?1,
       prev_event_key_ct = event_key_ct, prev_event_key_dek = event_key_dek, prev_event_key_iv = event_key_iv, prev_key_until = ?1,
       token_hash = ?2, token_ct = ?3, token_dek = ?4, token_iv = ?5,
       event_key_ct = ?6, event_key_dek = ?7, event_key_iv = ?8,
       config_version = config_version + 1
     WHERE app_id = ?9 AND token_hash = ?10
     RETURNING config_version`,
  ).bind(
    until, next.tokenHash, next.token.keyCiphertext, next.token.dekWrapped, next.token.iv,
    next.eventKey.keyCiphertext, next.eventKey.dekWrapped, next.eventKey.iv, appId, row.token_hash,
  ).first<{ config_version: number }>();
  if (!updated) throw new HttpError('the app worker changed during rotation; retry', 409);
  return { configVersion: updated.config_version };
}

// ── Removal (every backend) ─────────────────────────────────────────────────

/**
 * Revoke the worker's credentials and delete its stored code (ADR-009 §5).
 * Credentials first, so a token stops authorising before anything else
 * happens; `config_version` bumps so no cached isolate ID is ever reused.
 * Leaves `enabled` to the caller.
 */
async function removeCommon(env: Pick<Env, 'DB' | 'STORAGE'>, appId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE app_workers SET
       token_hash = NULL, token_ct = NULL, token_dek = NULL, token_iv = NULL,
       prev_token_hash = NULL, prev_token_until = NULL,
       event_key_ct = NULL, event_key_dek = NULL, event_key_iv = NULL,
       prev_event_key_ct = NULL, prev_event_key_dek = NULL, prev_event_key_iv = NULL, prev_key_until = NULL,
       bundle_sha256 = NULL, script_name = NULL, deployed_sha = NULL, deployed_ref = NULL, deployed_at = NULL,
       config_version = config_version + 1
     WHERE app_id = ?`,
  ).bind(appId).run();
  const keys = (await listAll(env.STORAGE, bundlePrefix(appId))).map((o) => o.key);
  for (let i = 0; i < keys.length; i += 1000) await env.STORAGE.delete(keys.slice(i, i + 1000));
}

/**
 * Turn an app's worker off and remove it: the admin flag-off path, the owner's
 * DELETE and app deletion all come here.
 */
export async function disableAppWorker(env: Env, appId: string): Promise<void> {
  await env.DB.prepare('UPDATE app_workers SET enabled = 0 WHERE app_id = ?').bind(appId).run();
  await appWorkerHost(env).remove(appId);
}

// ── Backends ────────────────────────────────────────────────────────────────

function unavailableHost(env: Env, backend: AppWorkerBackend | null, reason: string, status: number): AppWorkerHost {
  return {
    backend,
    deploy: async () => { throw new HttpError(reason, status); },
    invoke: async () => { throw new HttpError(reason, status); },
    remove: (appId) => removeCommon(env, appId),
  };
}

const shimShas = new Map<string, Promise<string>>();
/**
 * The identity of what the platform contributes to every loaded worker: the
 * shim, its limits and runtime settings. Part of the loader ID, so a platform
 * deploy that changes any of them starts fresh isolates.
 */
export function appWorkerShimSha(compatDate: string = APP_WORKER_COMPATIBILITY_DATE): Promise<string> {
  let sha = shimShas.get(compatDate);
  if (!sha) {
    sha = sha256Hex(JSON.stringify([APP_WORKER_SHIM, APP_WORKER_LIMITS, compatDate, COMPATIBILITY_FLAGS]));
    shimShas.set(compatDate, sha);
  }
  return sha;
}

/**
 * `<appId>:<bundle_sha256>:<config_version>:<SHIM_SHA>` — the loader caches
 * isolates by it (#253 §0), env included. So `config_version` must only ever
 * grow: an `app_workers` row is never deleted, only disabled and removed, which
 * bumps it. A recreated row would restart at 1 and could be handed an isolate
 * still holding a revoked token and event key.
 */
export function loaderId(appId: string, bundleSha: string, configVersion: number, shim: string): string {
  return `${appId}:${bundleSha}:${configVersion}:${shim}`;
}

function loaderHost(env: Env, loader: WorkerLoader, ctx?: AppWorkerExports): AppWorkerHost {
  return {
    backend: 'loader',

    async deploy(appId, bundle, source = {}) {
      const kek = kekOf(env);
      const sha = await bundleSha256(bundle);
      await storeBundle(env.STORAGE, appId, sha, bundle);
      const row = await env.DB.prepare('SELECT token_hash FROM app_workers WHERE app_id = ? AND enabled = 1').bind(appId).first<{ token_hash: string | null }>();
      if (!row) throw new HttpError('app workers are not enabled for this app', 403);
      const firstDeploy = !row.token_hash;
      const now = Date.now();
      // First deploy (or the first after a removal) mints the credentials and
      // bumps config_version, so an isolate cached with a revoked env is never
      // reused for the same bundle. Re-deploys keep both.
      const minted = firstDeploy ? await mintCredentials(kek) : null;
      const result = minted
        ? await env.DB.prepare(
          `UPDATE app_workers SET backend = 'loader', bundle_sha256 = ?1, deployed_sha = ?2, deployed_ref = ?3, deployed_at = ?4,
             token_hash = ?5, token_ct = ?6, token_dek = ?7, token_iv = ?8,
             event_key_ct = ?9, event_key_dek = ?10, event_key_iv = ?11, config_version = config_version + 1
           WHERE app_id = ?12 AND enabled = 1 AND token_hash IS NULL`,
        ).bind(
          sha, source.sha ?? null, source.ref ?? null, now,
          minted.tokenHash, minted.token.keyCiphertext, minted.token.dekWrapped, minted.token.iv,
          minted.eventKey.keyCiphertext, minted.eventKey.dekWrapped, minted.eventKey.iv, appId,
        ).run()
        : await env.DB.prepare(
          `UPDATE app_workers SET backend = 'loader', bundle_sha256 = ?1, deployed_sha = ?2, deployed_ref = ?3, deployed_at = ?4
           WHERE app_id = ?5 AND enabled = 1 AND token_hash IS NOT NULL`,
        ).bind(sha, source.sha ?? null, source.ref ?? null, now, appId).run();
      if (!result.meta.changes) throw new HttpError('the app worker changed during the deploy (disabled or deployed concurrently); retry', 409);
      await pruneBundles(env.STORAGE, appId, sha).catch((e) => console.warn(`[app-worker] bundle prune failed for ${appId}: ${(e as Error).message}`));
      return { backend: 'loader', bundleSha256: sha, firstDeploy };
    },

    async invoke(appId, event, { timeoutMs }) {
      const kek = kekOf(env);
      const w = await activeAppWorker(env, appId);
      if (!w || !w.bundle_sha256 || !w.token_hash) throw new HttpError('this app has no active app worker', 409);
      const now = Date.now();
      const keys = [await openSecret(sealed(w.event_key_ct, w.event_key_dek, w.event_key_iv), kek)];
      if (w.prev_key_until && w.prev_key_until > now && w.prev_event_key_ct) {
        keys.push(await openSecret(sealed(w.prev_event_key_ct, w.prev_event_key_dek, w.prev_event_key_iv), kek));
      } else if (w.prev_key_until || w.prev_token_until) {
        // The rotation overlap has passed: clear it now rather than on the next prune.
        await env.DB.prepare(
          `UPDATE app_workers SET prev_token_hash = NULL, prev_token_until = NULL, prev_event_key_ct = NULL,
             prev_event_key_dek = NULL, prev_event_key_iv = NULL, prev_key_until = NULL
           WHERE app_id = ? AND prev_key_until <= ? AND prev_token_until <= ?`,
        ).bind(appId, now, now).run();
      }

      const quota = await checkLogQuota(d1LogUsageStore(env.DB), { appId, clientKey: 'app-worker', entries: 1, nowMs: now });
      if (!quota.persist) throw new HttpError(`app worker invocation refused: log quota (${quota.reason})`, 429);

      const invocationId = `${event.id}:${event.attempt}`;
      try {
        await env.DB.prepare(
          `INSERT INTO app_worker_invocations (id, app_id, event_id, type, name, attempt, status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
        ).bind(invocationId, appId, event.id, event.type, event.name ?? null, event.attempt, now).run();
      } catch (e) {
        if (/UNIQUE/i.test(String((e as Error).message))) throw new HttpError(`invocation ${invocationId} already exists`, 409);
        throw e;
      }

      const body = JSON.stringify({
        v: 1, id: event.id, app_id: appId, type: event.type, ...(event.name ? { name: event.name } : {}),
        attempt: event.attempt, issued_at: now, ...(event.caller ? { caller: event.caller } : {}), payload: event.payload,
      });
      const signature = await signatureHeader(body, keys, now / 1000);
      const compatDate = compatibilityDate(env);
      const id = loaderId(appId, w.bundle_sha256, w.config_version, await appWorkerShimSha(compatDate));
      const bundleSha = w.bundle_sha256;
      const pas = ctx?.exports?.AppWorkerApi?.({ props: { appId } });
      if (!pas) console.warn(`[app-worker] invoking ${appId} without a PAS binding (no ctx.exports.AppWorkerApi)`);
      const worker = loader.get(id, async () => ({
        compatibilityDate: compatDate,
        compatibilityFlags: COMPATIBILITY_FLAGS,
        mainModule: SHIM_MODULE,
        modules: { ...(await loadBundle(env.STORAGE, appId, bundleSha)), [SHIM_MODULE]: APP_WORKER_SHIM },
        // ADR-009 §2: exactly these bindings. `PAS` is the AppWorkerApi stub (#254).
        env: {
          ...(pas ? { PAS: pas } : {}),
          PAS_WORKER_TOKEN: await openSecret(sealed(w.token_ct, w.token_dek, w.token_iv), kek),
          PAS_EVENT_KEY: keys[0],
          APP_ID: appId,
        },
        globalOutbound: null,
        limits: { ...APP_WORKER_LIMITS },
      }));

      let status: InvokeResult['status'] = 'failed';
      let httpStatus: number | null = null;
      let text: string | null = null;
      let error: string | null = null;
      try {
        const res = await withTimeout(
          worker.getEntrypoint().fetch(new Request('https://app-worker.invalid/', {
            method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature }, body,
          })),
          timeoutMs,
        );
        httpStatus = res.status;
        text = await res.text();
        status = res.ok ? 'succeeded' : 'failed';
      } catch (e) {
        status = e instanceof InvokeTimeout ? 'timeout' : 'failed';
        error = String((e as Error)?.message ?? e).slice(0, 500);
      }
      await env.DB.prepare(
        `UPDATE app_worker_invocations SET status = ?, http_status = ?, body_excerpt = ?, finished_at = ?, error = ? WHERE id = ?`,
      ).bind(status, httpStatus, status === 'failed' && text !== null ? excerpt(text) : null, Date.now(), error, invocationId).run();
      return { invocationId, status, httpStatus, body: text };
    },

    remove: (appId) => removeCommon(env, appId),
  };
}

/** The first `BODY_EXCERPT_BYTES` bytes of `text`, decoded back (a cut character becomes U+FFFD). */
export function excerpt(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength <= BODY_EXCERPT_BYTES ? text : new TextDecoder().decode(bytes.slice(0, BODY_EXCERPT_BYTES));
}

class InvokeTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InvokeTimeout(`timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
