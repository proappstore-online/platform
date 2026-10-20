import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { signCallback } from '../../../backend/src/lib/pags-client';
import { fallBackStalePagsRuns, PAGS_EVENT_TIMEOUT_MS, PAGS_NEEDS_YOU_TIMEOUT_MS } from '../../../backend/src/lib/pags-runs';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #456 on real D1: a verifier run is queued on a ProAgentStore agent (stubbed at the HTTP
// edge), reported on by signed callbacks, and falls back to the headless executor with a
// reason when the agent cannot take it, refuses it, or goes quiet.

const env = providedEnv as unknown as Env;
const APP = 'verify-demo';
const PAGS = 'https://pags.test';
const SECRET = 'pags-callback-secret';
const flow = { id: 'smoke', name: 'Smoke', steps: [{ op: 'expectText', text: 'Sign in' }] };

type Run = Record<string, unknown>;
const owner = () => session('gh:1');

async function bind(instanceId = 'inst-12345678', extra: Record<string, unknown> = {}) {
  return SELF.fetch(`${BASE}/v1/apps/${APP}/qa/pags`, json('PUT', { instanceId, repo: 'proappstore-online/verify-demo', ...extra }, await owner()));
}
/** Stub the PAGS queue endpoint; returns the bodies it received. */
function pagsAccepts(jobId: string, status = 202): unknown[] {
  const bodies: unknown[] = [];
  fetchMock.get(PAGS).intercept({ path: '/v1/verifier/jobs', method: 'POST' }).reply(status, (req) => {
    bodies.push({ auth: (req.headers as Record<string, string>).authorization, body: JSON.parse(String(req.body)) });
    return status === 202 ? { job_id: jobId } : { error: 'no' };
  });
  return bodies;
}
async function queue(body: Record<string, unknown> = { engine: 'pags' }) {
  const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/qa/runs`, json('POST', body, await owner()));
  return { res, body: (await res.json()) as { runs: { runId: string; engine: string; pagsJobId?: string; fallbackReason?: string }[]; error?: string } };
}
const row = async (runId: string) => (await env.DB.prepare('SELECT * FROM app_test_runs WHERE run_id = ?').bind(runId).first<Run>())!;
async function callback(payload: Record<string, unknown>, opts: { ts?: number; secret?: string; sig?: string } = {}) {
  const raw = JSON.stringify(payload);
  const ts = String(opts.ts ?? Date.now());
  return SELF.fetch(`${BASE}/v1/pags/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PAS-Timestamp': ts, 'X-PAS-Signature': opts.sig ?? (await signCallback(opts.secret ?? SECRET, ts, raw)) },
    body: raw,
  });
}
const ev = (jobId: string, n: number, state: string, extra: Record<string, unknown> = {}) => ({ event_id: `${jobId}-${n}`, job_id: jobId, state, ...extra });

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_test_flows', 'app_test_runs', 'app_pags_bindings', 'pags_callback_events']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
  await seedUser('gh:2'); await seedApp('other-app', 'gh:2');
  await env.DB.prepare("INSERT INTO app_test_flows (app_id, flow_id, name, spec, updated_by, updated_at) VALUES (?, 'smoke', 'Smoke', ?, 'gh:1', 1)").bind(APP, JSON.stringify(flow)).run();
});

describe('owner binding (#456)', () => {
  it('the owner binds the app to an agent instance; others cannot; invalid ids are refused', async () => {
    expect(await (await SELF.fetch(`${BASE}/v1/apps/${APP}/qa/pags`, json('GET', undefined, await owner()))).json()).toEqual({ configured: true, binding: null });
    const put = await bind('inst-12345678', { enabled: true });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ configured: true, binding: { instanceId: 'inst-12345678', repo: 'proappstore-online/verify-demo', enabled: true, updatedBy: 'gh:1' } });
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/qa/pags`, json('PUT', { instanceId: 'inst-12345678' }, await session('gh:2')))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/qa/pags`, json('GET'))).status).toBe(401);
    for (const bad of [{ instanceId: 'x' }, { instanceId: 'has space 123' }, { instanceId: 'inst-12345678', repo: 'nope' }, { instanceId: 'inst-12345678', enabled: 'yes' }, {}]) {
      expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/qa/pags`, json('PUT', bad, await owner()))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/qa/pags`, json('DELETE', undefined, await owner()))).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_pags_bindings').first()).toEqual({ n: 0 });
  });
});

describe('the lifecycle of a verifier run on a ProAgentStore agent (#456)', () => {
  it('queues on the bound instance, follows signed events (running, a question, done), and exposes status and the question', async () => {
    await bind();
    const received = pagsAccepts('job-1');
    const { res, body } = await queue();
    expect(res.status).toBe(200);
    const runId = body.runs[0]!.runId;
    expect(body.runs[0]).toMatchObject({ engine: 'pags', pagsJobId: 'job-1' });
    expect(received).toEqual([{ auth: 'Bearer pags-limited-token', body: expect.objectContaining({
      instance_id: 'inst-12345678', repo: 'proappstore-online/verify-demo', app_id: APP, run_id: runId, app_url: `https://${APP}.proappstore.online`,
      callback_url: 'https://api.proappstore.online/v1/pags/callback', flows: [{ flow_id: 'smoke', name: 'Smoke', spec: flow }],
    }) }]);
    expect(await row(runId)).toMatchObject({ engine: 'pags', status: 'queued', pags_state: 'queued', pags_job_id: 'job-1', fallback_reason: null });

    expect((await callback(ev('job-1', 1, 'running'))).status).toBe(200);
    expect(await row(runId)).toMatchObject({ status: 'running', pags_state: 'running' });

    const asked = await callback(ev('job-1', 2, 'needs-you', { question: 'Which account should I sign in with?', note: 'blocked at sign-in' }));
    expect(await asked.json()).toEqual({ ok: true, applied: true });
    const mid = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/qa/runs/${runId}`, json('GET', undefined, await owner()))).json() as { run: Run; pags: Record<string, unknown> };
    expect(mid.run).toMatchObject({ status: 'running', engine: 'pags', pags_state: 'needs-you' });
    expect(mid.pags).toMatchObject({ engine: 'pags', jobId: 'job-1', state: 'needs-you', fallbackReason: null, detail: { question: 'Which account should I sign in with?', note: 'blocked at sign-in' } });

    // A redelivery of the same event id changes nothing.
    expect(await (await callback(ev('job-1', 2, 'needs-you', { question: 'different' }))).json()).toEqual({ ok: true, duplicate: true });
    expect(((await row(runId)).pags_detail as string)).toContain('Which account');

    const done = await callback(ev('job-1', 3, 'done', {
      result: { status: 'passed', steps_total: 4, steps_passed: 4, failed_step: null },
      report_url: 'https://github.com/proappstore-online/verify-demo/issues/1', screenshots: ['https://r2.example/final.png'],
    }));
    expect(await done.json()).toEqual({ ok: true, applied: true });
    expect(await row(runId)).toMatchObject({ status: 'passed', steps_total: 4, steps_passed: 4, failed_step: null, pags_state: 'done', error: null });
    expect((await row(runId)).finished_at).toEqual(expect.any(Number));
    const final = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/qa/runs/${runId}`, json('GET', undefined, await owner()))).json() as { pags: { detail: Record<string, unknown> } };
    expect(final.pags.detail).toMatchObject({ report_url: 'https://github.com/proappstore-online/verify-demo/issues/1', screenshots: ['https://r2.example/final.png'] });

    // A finished run is final: a late event does not reopen it.
    expect(await (await callback(ev('job-1', 4, 'running'))).json()).toEqual({ ok: true, applied: false, ignored: 'the run has finished' });
    expect(await row(runId)).toMatchObject({ status: 'passed', pags_state: 'done' });
  });

  it('a failed verdict and a failed agent land as failed and error', async () => {
    await bind();
    pagsAccepts('job-f');
    const a = (await queue()).body.runs[0]!.runId;
    await callback(ev('job-f', 1, 'done', { result: { status: 'failed', steps_total: 5, steps_passed: 2, failed_step: 2, error: 'expected "Sign in"' } }));
    expect(await row(a)).toMatchObject({ status: 'failed', steps_passed: 2, failed_step: 2, error: 'expected "Sign in"' });

    pagsAccepts('job-e');
    const b = (await queue()).body.runs[0]!.runId;
    await callback(ev('job-e', 1, 'failed', { note: 'the machine went offline' }));
    expect(await row(b)).toMatchObject({ status: 'error', pags_state: 'failed', error: 'the machine went offline' });

    pagsAccepts('job-n');
    const c = (await queue()).body.runs[0]!.runId;
    await callback(ev('job-n', 1, 'done'));
    expect(await row(c)).toMatchObject({ status: 'error', error: 'the agent reported done without a pass/fail result' });
  });

  it('refuses unsigned, wrongly signed, tampered and stale callbacks; unknown jobs 404; bad bodies 400', async () => {
    await bind();
    pagsAccepts('job-s');
    const runId = (await queue()).body.runs[0]!.runId;
    const good = ev('job-s', 1, 'running');
    expect((await callback(good, { secret: 'wrong' })).status).toBe(401);
    expect((await callback(good, { sig: 'sha256=' + '0'.repeat(64) })).status).toBe(401);
    expect((await callback(good, { ts: Date.now() - 10 * 60_000 })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/pags/callback`, { method: 'POST', body: JSON.stringify(good) })).status).toBe(401);
    // Signed over one body, sent with another.
    const ts = String(Date.now());
    const tampered = await SELF.fetch(`${BASE}/v1/pags/callback`, { method: 'POST', headers: { 'X-PAS-Timestamp': ts, 'X-PAS-Signature': await signCallback(SECRET, ts, JSON.stringify(good)) }, body: JSON.stringify(ev('job-s', 1, 'done')) });
    expect(tampered.status).toBe(401);
    expect(await row(runId)).toMatchObject({ status: 'queued', pags_state: 'queued' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pags_callback_events').first()).toEqual({ n: 0 });
    expect((await callback(ev('no-such-job', 1, 'running'))).status).toBe(404);
    expect((await callback({ ...good, state: 'paused' })).status).toBe(400);
    expect((await callback({ job_id: 'job-s' })).status).toBe(400);
  });
});

describe('falling back to the headless executor, with the reason (#456)', () => {
  const fellBack = (b: Awaited<ReturnType<typeof queue>>['body'], reason: string | RegExp) => {
    expect(b.runs[0]).toMatchObject({ engine: 'headless' });
    expect(b.runs[0]!.fallbackReason).toMatch(reason instanceof RegExp ? reason : new RegExp(`^${reason}$`));
  };

  it('no binding for the app', async () => {
    const { body } = await queue();
    fellBack(body, 'no_binding');
    expect(await row(body.runs[0]!.runId)).toMatchObject({ engine: 'headless', fallback_reason: 'no_binding', pags_job_id: null });
  });

  it('a disabled binding, an overloaded runner (429/503), and a refusal', async () => {
    await bind('inst-12345678', { enabled: false });
    fellBack((await queue()).body, 'binding_disabled');
    await bind();
    fetchMock.get(PAGS).intercept({ path: '/v1/verifier/jobs', method: 'POST' }).reply(429, { error: 'busy' });
    fellBack((await queue()).body, 'pags_overloaded');
    fetchMock.get(PAGS).intercept({ path: '/v1/verifier/jobs', method: 'POST' }).reply(503, '');
    fellBack((await queue()).body, 'pags_overloaded');
    fetchMock.get(PAGS).intercept({ path: '/v1/verifier/jobs', method: 'POST' }).reply(401, '');
    fellBack((await queue()).body, 'pags_unauthorized');
    fetchMock.get(PAGS).intercept({ path: '/v1/verifier/jobs', method: 'POST' }).reply(500, '');
    fellBack((await queue()).body, 'pags_refused_500');
    fetchMock.get(PAGS).intercept({ path: '/v1/verifier/jobs', method: 'POST' }).replyWithError(new Error('connection refused'));
    fellBack((await queue()).body, 'pags_unreachable');
  });

  it('the headless default is unchanged, and engine "pags" cannot be asked of a browser run', async () => {
    const { body } = await queue({});
    expect(body.runs[0]).toEqual({ runId: expect.any(String), flowId: 'smoke', engine: 'headless' });
    const refused = await SELF.fetch(`${BASE}/v1/apps/${APP}/qa/runs`, json('POST', { engine: 'pags', trigger: 'browser' }, await owner()));
    expect(refused.status).toBe(400);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/qa/runs`, json('POST', { engine: 'gpt' }, await owner()))).status).toBe(400);
  });

  it('an agent that goes quiet: the tick re-queues the run headlessly, with the reason, and a late callback is ignored', async () => {
    await bind();
    pagsAccepts('job-q');
    const runId = (await queue()).body.runs[0]!.runId;
    await callback(ev('job-q', 1, 'running'));
    const now = Date.now();
    // Not yet quiet long enough.
    expect(await fallBackStalePagsRuns(env, now + PAGS_EVENT_TIMEOUT_MS - 60_000)).toBe(0);
    expect(await row(runId)).toMatchObject({ engine: 'pags', status: 'running' });
    expect(await fallBackStalePagsRuns(env, now + PAGS_EVENT_TIMEOUT_MS + 60_000)).toBe(1);
    expect(await row(runId)).toMatchObject({ engine: 'headless', status: 'queued', claimed_at: null, fallback_reason: expect.stringMatching(/^pags_timeout: no event from the agent for 1[56] min$/) });
    const late = await callback(ev('job-q', 2, 'done', { result: { status: 'passed' } }));
    expect(await late.json()).toEqual({ ok: true, ignored: 'superseded: the run fell back to the headless executor' });
    expect(await row(runId)).toMatchObject({ engine: 'headless', status: expect.stringMatching(/^(queued|running|error|passed|failed)$/) });
  });

  it('a question waiting on a person gets the longer allowance, then falls back', async () => {
    await bind();
    pagsAccepts('job-w');
    const runId = (await queue()).body.runs[0]!.runId;
    await callback(ev('job-w', 1, 'needs-you', { question: 'Which account?' }));
    const now = Date.now();
    expect(await fallBackStalePagsRuns(env, now + PAGS_EVENT_TIMEOUT_MS + 60_000)).toBe(0);
    expect((await row(runId)).engine).toBe('pags');
    expect(await fallBackStalePagsRuns(env, now + PAGS_NEEDS_YOU_TIMEOUT_MS + 60_000)).toBe(1);
    expect(await row(runId)).toMatchObject({ engine: 'headless', fallback_reason: expect.stringMatching(/^pags_needs_you_unanswered: no answer for/) });
  });

  it('finished runs and headless runs are never touched by the sweep', async () => {
    await bind();
    pagsAccepts('job-d');
    const done = (await queue()).body.runs[0]!.runId;
    await callback(ev('job-d', 1, 'done', { result: { status: 'passed' } }));
    await queue({});
    expect(await fallBackStalePagsRuns(env, Date.now() + 10 * 24 * 3600_000)).toBe(0);
    expect(await row(done)).toMatchObject({ engine: 'pags', status: 'passed' });
  });
});
