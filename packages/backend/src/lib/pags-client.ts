/**
 * The platform's side of the ProAgentStore (PAGS) verifier trial (#456).
 *
 * A Worker that only passes messages: it queues a browser-verifier job on the PAGS
 * agent instance bound to the app, and PAGS tells it how the run went through a
 * signed callback (routes/pags.ts). The engine runs on the subscriber's machine under
 * their subscription; no login ever reaches Cloudflare. The token held here is the
 * LIMITED one (queue work, read status on chosen instances), kept as a Worker secret.
 *
 * Contract this client speaks (the four PAGS additions in docs/pags-verifier.md):
 *   POST {PAGS_API_URL}/v1/verifier/jobs   Authorization: Bearer {PAGS_TOKEN}
 *     { instance_id, repo, app_id, app_url, run_id, flows: [{ flow_id, name, spec }],
 *       callback_url }
 *   → 202 { job_id }.  429 / 503 mean the runner is overloaded.
 *
 * Every failure is a FALLBACK REASON, never an exception: the caller runs the flows on
 * the headless executor instead and records the reason on the run.
 */
import type { Env } from '../types.js';

/** Where PAGS posts run-state events. */
export const PAGS_CALLBACK_URL = 'https://api.proappstore.online/v1/pags/callback';
const QUEUE_TIMEOUT_MS = 8_000;
/** A run's flow specs are sent whole; a larger job is run headlessly instead. */
export const MAX_JOB_FLOWS_BYTES = 64 * 1024;

export interface PagsBinding { instance_id: string; repo: string | null; enabled: number }
export interface JobFlow { flow_id: string; name: string; spec: unknown }

export type QueueResult = { ok: true; jobId: string } | { ok: false; reason: string };

/** Whether this deployment can talk to PAGS at all. */
export function pagsConfigured(env: Pick<Env, 'PAGS_API_URL' | 'PAGS_TOKEN' | 'PAGS_CALLBACK_SECRET'>): boolean {
  return Boolean(env.PAGS_API_URL && env.PAGS_TOKEN && env.PAGS_CALLBACK_SECRET);
}

/** A job id as PAGS issues it: opaque, bounded, URL-safe. */
export const JOB_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export async function queueVerifierJob(
  env: Env,
  binding: PagsBinding | null,
  job: { appId: string; runId: string; flows: JobFlow[] },
  fetcher: typeof fetch = fetch,
): Promise<QueueResult> {
  if (!pagsConfigured(env)) return { ok: false, reason: 'pags_not_configured' };
  if (!binding) return { ok: false, reason: 'no_binding' };
  if (!binding.enabled) return { ok: false, reason: 'binding_disabled' };
  if (JSON.stringify(job.flows).length > MAX_JOB_FLOWS_BYTES) return { ok: false, reason: 'flows_too_large' };
  let res: Response;
  try {
    res = await fetcher(`${env.PAGS_API_URL!.replace(/\/+$/, '')}/v1/verifier/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.PAGS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: binding.instance_id,
        repo: binding.repo,
        app_id: job.appId,
        app_url: `https://${job.appId}.proappstore.online`,
        run_id: job.runId,
        flows: job.flows,
        callback_url: PAGS_CALLBACK_URL,
      }),
      signal: AbortSignal.timeout(QUEUE_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, reason: (e as Error)?.name === 'TimeoutError' ? 'pags_timeout' : 'pags_unreachable' };
  }
  if (res.status === 429 || res.status === 503) return { ok: false, reason: 'pags_overloaded' };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'pags_unauthorized' };
  if (res.status !== 202 && res.status !== 200 && res.status !== 201) return { ok: false, reason: `pags_refused_${res.status}` };
  const body = (await res.json().catch(() => null)) as { job_id?: unknown } | null;
  if (typeof body?.job_id !== 'string' || !JOB_ID_RE.test(body.job_id)) return { ok: false, reason: 'pags_bad_response' };
  return { ok: true, jobId: body.job_id };
}

// ── signed callback ──────────────────────────────────────────────────────────

/** A callback's timestamp must be this close to now, either way: replay is bounded. */
export const CALLBACK_SKEW_MS = 5 * 60_000;

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** `sha256=<hex>` over `<timestamp>.<raw body>` with the shared secret. */
export async function signCallback(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${rawBody}`)))}`;
}

export type CallbackVerdict = 'ok' | 'unconfigured' | 'bad_timestamp' | 'stale' | 'bad_signature';

/** Verify a callback in constant time. The timestamp is in the signed text, so it cannot be swapped. */
export async function verifyCallback(
  secret: string | undefined,
  headers: { timestamp: string | null; signature: string | null },
  rawBody: string,
  now = Date.now(),
): Promise<CallbackVerdict> {
  if (!secret) return 'unconfigured';
  const ts = headers.timestamp ?? '';
  if (!/^\d{10,16}$/.test(ts)) return 'bad_timestamp';
  if (Math.abs(now - Number(ts)) > CALLBACK_SKEW_MS) return 'stale';
  const expected = enc.encode(await signCallback(secret, ts, rawBody));
  const given = enc.encode(headers.signature ?? '');
  if (given.length !== expected.length) return 'bad_signature';
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ given[i]!;
  return diff === 0 ? 'ok' : 'bad_signature';
}
