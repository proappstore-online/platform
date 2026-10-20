import { describe, expect, it, vi } from 'vitest';
import { CALLBACK_SKEW_MS, PAGS_CALLBACK_URL, pagsConfigured, queueVerifierJob, signCallback, verifyCallback, type PagsBinding } from './pags-client.js';
import type { Env } from '../types.js';

// #456: the PAGS client turns every failure into a fallback reason, and the callback is
// verified in constant time over `<timestamp>.<raw body>`.

const SECRET = 'shared-secret';
const env = { PAGS_API_URL: 'https://pags.test/', PAGS_TOKEN: 'tok', PAGS_CALLBACK_SECRET: SECRET } as unknown as Env;
const binding: PagsBinding = { instance_id: 'inst-12345678', repo: 'proappstore-online/club', enabled: 1 };
const job = { appId: 'club', runId: 'run-1', flows: [{ flow_id: 'smoke', name: 'Smoke', spec: { id: 'smoke', steps: [] } }] };
const reply = (status: number, body?: unknown) => vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('queueVerifierJob (#456)', () => {
  it('queues the job with the limited token, the binding, the flows and the callback URL', async () => {
    const f = reply(202, { job_id: 'job-1' });
    expect(await queueVerifierJob(env, binding, job, f)).toEqual({ ok: true, jobId: 'job-1' });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://pags.test/v1/verifier/jobs');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init.body))).toEqual({
      instance_id: 'inst-12345678', repo: 'proappstore-online/club', app_id: 'club', app_url: 'https://club.proappstore.online',
      run_id: 'run-1', flows: job.flows, callback_url: PAGS_CALLBACK_URL,
    });
  });

  it.each<[string, Env | Partial<Env>, PagsBinding | null, string]>([
    ['no API URL', { ...env, PAGS_API_URL: undefined } as Env, binding, 'pags_not_configured'],
    ['no token', { ...env, PAGS_TOKEN: undefined } as Env, binding, 'pags_not_configured'],
    ['no callback secret', { ...env, PAGS_CALLBACK_SECRET: undefined } as Env, binding, 'pags_not_configured'],
    ['no binding', env, null, 'no_binding'],
    ['a disabled binding', env, { ...binding, enabled: 0 }, 'binding_disabled'],
  ])('falls back without calling PAGS: %s → %s', async (_label, e, b, reason) => {
    const f = reply(202, { job_id: 'x' });
    expect(await queueVerifierJob(e as Env, b, job, f)).toEqual({ ok: false, reason });
    expect(f).not.toHaveBeenCalled();
  });

  it('flows too large to send run headlessly', async () => {
    const big = { ...job, flows: [{ flow_id: 'a', name: 'a', spec: 'x'.repeat(70_000) }] };
    expect(await queueVerifierJob(env, binding, big, reply(202, { job_id: 'x' }))).toEqual({ ok: false, reason: 'flows_too_large' });
  });

  it.each<[string, typeof fetch, string]>([
    ['429 (the runner is overloaded)', reply(429), 'pags_overloaded'],
    ['503', reply(503), 'pags_overloaded'],
    ['401', reply(401), 'pags_unauthorized'],
    ['403', reply(403), 'pags_unauthorized'],
    ['500', reply(500), 'pags_refused_500'],
    ['422', reply(422, { error: 'x' }), 'pags_refused_422'],
    ['202 without a job id', reply(202, {}), 'pags_bad_response'],
    ['202 with an unsafe job id', reply(202, { job_id: '../etc' }), 'pags_bad_response'],
    ['202 with a non-JSON body', vi.fn(async () => new Response('ok', { status: 202 })) as unknown as typeof fetch, 'pags_bad_response'],
    ['a network failure', vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch, 'pags_unreachable'],
    ['a timeout', vi.fn(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as unknown as typeof fetch, 'pags_timeout'],
  ])('falls back with a named reason: %s → %s', async (_label, f, reason) => {
    expect(await queueVerifierJob(env, binding, job, f)).toEqual({ ok: false, reason });
  });

  it('pagsConfigured needs all three settings', () => {
    expect(pagsConfigured(env)).toBe(true);
    expect(pagsConfigured({})).toBe(false);
    expect(pagsConfigured({ PAGS_API_URL: 'u', PAGS_TOKEN: 't' })).toBe(false);
  });
});

describe('callback signature (#456)', () => {
  const body = JSON.stringify({ event_id: 'e1', job_id: 'j1', state: 'running' });
  const now = 1_800_000_000_000;
  const sign = (ts: string, b = body, secret = SECRET) => signCallback(secret, ts, b);
  const verify = async (over: { ts?: string | null; sig?: string | null; body?: string; secret?: string | undefined; at?: number } = {}) => {
    const ts = over.ts === undefined ? String(now) : over.ts;
    const sig = over.sig === undefined ? await sign(ts ?? '') : over.sig;
    return verifyCallback('secret' in over ? over.secret : SECRET, { timestamp: ts, signature: sig }, over.body ?? body, over.at ?? now);
  };

  it('accepts a correctly signed, fresh body', async () => {
    expect(await verify()).toBe('ok');
    expect(await sign(String(now))).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('refuses a tampered body, a wrong secret, a wrong or missing signature', async () => {
    expect(await verify({ body: body.replace('running', 'done') })).toBe('bad_signature');
    expect(await verify({ sig: await sign(String(now), body, 'other-secret') })).toBe('bad_signature');
    expect(await verify({ sig: 'sha256=' + '0'.repeat(64) })).toBe('bad_signature');
    expect(await verify({ sig: null })).toBe('bad_signature');
    expect(await verify({ sig: 'sha256=abc' })).toBe('bad_signature');
  });

  it('bounds replay: a stale or future timestamp is refused, and the timestamp is part of the signature', async () => {
    expect(await verify({ ts: String(now - CALLBACK_SKEW_MS - 1) })).toBe('stale');
    expect(await verify({ ts: String(now + CALLBACK_SKEW_MS + 1) })).toBe('stale');
    expect(await verify({ ts: String(now - CALLBACK_SKEW_MS) })).toBe('ok');
    // The signature of an old timestamp does not carry over to a fresh one.
    expect(await verify({ ts: String(now), sig: await sign(String(now - 1_000)) })).toBe('bad_signature');
    expect(await verify({ ts: 'yesterday' })).toBe('bad_timestamp');
    expect(await verify({ ts: null })).toBe('bad_timestamp');
  });

  it('with no secret configured nothing verifies', async () => {
    expect(await verify({ secret: undefined })).toBe('unconfigured');
    expect(await verify({ secret: '' })).toBe('unconfigured');
  });
});
