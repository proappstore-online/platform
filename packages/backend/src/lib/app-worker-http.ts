/**
 * The one way the platform sends an `http` event to an app's worker as a signed-in user (#260, #579). The browser
 * plane (routes/app-workers.ts) and worker-backed actions (routes/actions.ts) both use it; it lives here, not in a
 * route file, so neither route imports the other.
 */
import type { Env } from '../types.js';
import { HttpError, type FasUser } from './auth.js';
import { appWorkerHost, type AppWorkerExports } from './app-worker-host.js';
import { mintCallerGrant } from './caller-grant.js';
import { AppWorkerQuotaError } from './app-worker-usage.js';
import { decodeEnvelopeBody, encodeEnvelopeBody } from '../app-worker-shim/body.js';

/** The largest document a worker may store (10 MiB). Defined here, not in app-worker-calls.ts, which imports the action route that imports this file. */
export const MAX_WORKER_OBJECT_BYTES = 10 * 1024 * 1024;
/**
 * #385: a document the worker may store (MAX_WORKER_OBJECT_BYTES, 10 MiB) plus
 * 1 MiB for multipart/form-data framing, so a full-size document fits either
 * raw or in a form. Responses get the same bound, so a stored document can be
 * downloaded back through the same path.
 */
export const WORKER_HTTP_MAX_REQUEST_BYTES = MAX_WORKER_OBJECT_BYTES + 1024 * 1024;
export const WORKER_HTTP_MAX_RESPONSE_BYTES = WORKER_HTTP_MAX_REQUEST_BYTES;
/** ADR-009 §4: http events get 30 s. They are never retried. */
const WORKER_HTTP_TIMEOUT_MS = 30_000;
/** All a worker response may carry back; Cache-Control is forced, Set-Cookie and the rest never pass. */
const RESPONSE_HEADERS = ['content-type', 'etag'];

/**
 * One `http` event to the app's worker as `user`, answered as a Response: the browser plane's `/worker/http` route and a
 * `worker` action (#579, routes/actions.ts) share it. The platform mints a 30-second caller grant for the user and
 * invokes the worker; the worker's `{ v: 1, status, headers, body, body_encoding }` reply becomes the Response, with
 * only `content-type` and `etag` passed and `Cache-Control: private, no-store` forced. A quota refusal is a 429 with
 * Retry-After, a timeout a 504, a reply that is not a valid envelope a 502. A worker 4xx or 5xx keeps its status.
 */
export async function invokeAppWorkerHttp(
  env: Env,
  ctx: AppWorkerExports | undefined,
  appId: string,
  user: FasUser,
  req: { method: string; path: string; query: string; headers: Record<string, string>; body: Uint8Array },
): Promise<Response> {
  // #318: the grant is minted for this envelope (id, attempt) and works only from its invocation.
  const event = { id: crypto.randomUUID(), attempt: 1 };
  const result = await appWorkerHost(env, ctx).invoke(appId, {
    id: event.id,
    type: 'http',
    attempt: event.attempt,
    payload: {
      method: req.method,
      path: req.path,
      query: req.query,
      headers: req.headers,
      ...encodeEnvelopeBody(req.body, req.headers['content-type'] ?? null),
    },
    caller: await mintCallerGrant(env, appId, user, event),
  }, { timeoutMs: WORKER_HTTP_TIMEOUT_MS }).catch((e: unknown) => {
    // #275: an interactive request is refused honestly, with when to come back.
    if (e instanceof AppWorkerQuotaError) return e;
    throw e;
  });
  if (result instanceof AppWorkerQuotaError) {
    return Response.json({ error: result.message, quota: result.quota }, { status: 429, headers: { 'Retry-After': String(result.retryAfter), 'Cache-Control': 'private, no-store' } });
  }

  if (result.status === 'timeout') throw new HttpError('the app worker did not answer in time', 504);
  let wrapped: { v?: unknown; status?: unknown; headers?: Record<string, string>; body?: unknown; body_encoding?: unknown };
  try {
    wrapped = JSON.parse(result.body ?? '');
  } catch {
    throw new HttpError('the app worker failed', 502);
  }
  if (wrapped.v !== 1 || typeof wrapped.status !== 'number' || wrapped.status < 200 || wrapped.status > 599) throw new HttpError('the app worker failed', 502);
  const body = decodeEnvelopeBody(wrapped.body, wrapped.body_encoding);
  if (body.byteLength > WORKER_HTTP_MAX_RESPONSE_BYTES) throw new HttpError('the app worker response is too large', 502);
  const out = new Headers({ 'Cache-Control': 'private, no-store' });
  for (const name of RESPONSE_HEADERS) {
    const value = wrapped.headers?.[name];
    if (typeof value === 'string') out.set(name, value);
  }
  const nullBody = [204, 205, 304].includes(wrapped.status) || req.method === 'HEAD';
  return new Response(nullBody ? null : body, { status: wrapped.status, headers: out });
}
