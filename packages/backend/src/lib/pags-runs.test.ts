import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { applyPagsEvent, fallBackStalePagsRuns, fallBackToHeadless, PAGS_EVENT_TIMEOUT_MS, PAGS_NEEDS_YOU_TIMEOUT_MS, parsePagsEvent, type PagsEvent } from './pags-runs.js';
import type { Env } from '../types.js';

// #456: what a callback body may carry. Everything is bounded and URLs are https only.
describe('parsePagsEvent', () => {
  const base = { event_id: 'e-1', job_id: 'job-1', state: 'running' };
  it('accepts the five states', () => {
    for (const state of ['queued', 'running', 'needs-you', 'done', 'failed']) expect(parsePagsEvent({ ...base, state })).toMatchObject({ event: { state } });
  });
  it('refuses a body that is not an object, an unsafe or missing id, or an unknown state', () => {
    for (const bad of [null, 'x', [], { ...base, event_id: '' }, { ...base, event_id: 'a b' }, { ...base, job_id: '../x' }, { ...base, state: 'paused' }, { job_id: 'j', state: 'done' }]) {
      expect(parsePagsEvent(bad), JSON.stringify(bad)).toEqual({ error: expect.any(String) });
    }
  });
  it('keeps only https report and screenshot URLs, caps the lists and the text', () => {
    const r = parsePagsEvent({
      ...base, state: 'needs-you', question: 'q'.repeat(2000), note: ' hello ',
      report_url: 'http://insecure.example/r', screenshots: ['https://a.example/1.png', 'javascript:alert(1)', 'http://b.example/2.png', ...Array(20).fill('https://c.example/x.png')],
    }) as { event: { question: string; note: string; report_url?: string; screenshots: string[] } };
    expect(r.event.question).toHaveLength(1000);
    expect(r.event.note).toBe('hello');
    expect(r.event.report_url).toBeUndefined();
    expect(r.event.screenshots).toHaveLength(10);
    expect(r.event.screenshots.every((u) => u.startsWith('https://'))).toBe(true);
    expect(parsePagsEvent({ ...base, report_url: 'https://github.com/o/r/pull/1' })).toMatchObject({ event: { report_url: 'https://github.com/o/r/pull/1' } });
  });
  it('reads a result with bounded integers', () => {
    const r = parsePagsEvent({ ...base, state: 'done', result: { status: 'passed', steps_total: 5, steps_passed: 5, failed_step: null } }) as { event: { result: Record<string, unknown> } };
    expect(r.event.result).toMatchObject({ status: 'passed', steps_total: 5, steps_passed: 5, failed_step: null });
    const bad = parsePagsEvent({ ...base, state: 'done', result: { status: 'passed', steps_total: -1, steps_passed: 1.5 } }) as { event: { result: Record<string, unknown> } };
    expect(bad.event.result.steps_total).toBeUndefined();
    expect(bad.event.result.steps_passed).toBeUndefined();
  });
});

// The SQL itself runs against real D1 in runtime-tests/pags-verifier.test.ts; these pin the
// shape each state writes and that only an open pags run can change.
function recordingDb(changes = 1, rows: unknown[] = []) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: (sql: string) => {
      const entry = { sql, args: [] as unknown[] };
      calls.push(entry);
      const st = {
        bind: (...a: unknown[]) => { entry.args = a; return st; },
        run: async () => ({ meta: { changes } }),
        all: async () => ({ results: rows }),
      };
      return st;
    },
  } as unknown as D1Database;
  return { db, calls };
}
const event = (e: Partial<PagsEvent> & Pick<PagsEvent, 'state'>): PagsEvent => ({ event_id: 'e', job_id: 'j', ...e });

describe('applyPagsEvent', () => {
  it('done writes the verdict and finishes the run; only an open pags run is matched', async () => {
    const { db, calls } = recordingDb();
    expect(await applyPagsEvent(db, 'j', event({ state: 'done', result: { status: 'failed', steps_total: 5, steps_passed: 2, failed_step: 2, error: 'x' } }), 1000)).toBe(true);
    expect(calls[0]!.sql).toContain("engine = 'pags' AND status IN ('queued', 'running')");
    expect(calls[0]!.sql).toContain('finished_at');
    expect(calls[0]!.args.slice(0, 6)).toEqual(['j', 'failed', 5, 2, 2, 'x']);
  });
  it('done without a pass/fail is an error; failed is an error with the note', async () => {
    const a = recordingDb();
    await applyPagsEvent(a.db, 'j', event({ state: 'done' }), 1);
    expect(a.calls[0]!.args[1]).toBe('error');
    const b = recordingDb();
    await applyPagsEvent(b.db, 'j', event({ state: 'failed', note: 'offline' }), 1);
    expect(b.calls[0]!.args[1]).toBe('offline');
    const c = recordingDb();
    await applyPagsEvent(c.db, 'j', event({ state: 'failed' }), 1);
    expect(c.calls[0]!.args[1]).toBe('the agent run failed');
  });
  it('queued, running and needs-you keep the run open; a question waits as running', async () => {
    for (const [state, status] of [['queued', 'queued'], ['running', 'running'], ['needs-you', 'running']] as const) {
      const { db, calls } = recordingDb();
      await applyPagsEvent(db, 'j', event({ state, question: state === 'needs-you' ? 'which?' : undefined }), 5);
      expect(calls[0]!.args.slice(0, 4)).toEqual(['j', status, state, 5]);
      expect(calls[0]!.sql).not.toContain('finished_at');
    }
  });
  it('reports whether a row changed, and keeps the stored detail small', async () => {
    expect(await applyPagsEvent(recordingDb(0).db, 'j', event({ state: 'running' }), 1)).toBe(false);
    const { db, calls } = recordingDb();
    await applyPagsEvent(db, 'j', event({ state: 'running', note: 'n', screenshots: ['https://a.example/1.png'] }), 1);
    expect(JSON.parse(String(calls[0]!.args[4]))).toEqual({ note: 'n', screenshots: ['https://a.example/1.png'] });
    const none = recordingDb();
    await applyPagsEvent(none.db, 'j', event({ state: 'running' }), 1);
    expect(none.calls[0]!.args[4]).toBeNull();
    const big = recordingDb();
    await applyPagsEvent(big.db, 'j', event({ state: 'running', note: 'n'.repeat(500), question: 'q'.repeat(1000), screenshots: Array(10).fill('https://a.example/' + 'x'.repeat(280)) }), 1);
    expect(String(big.calls[0]!.args[4]).length).toBeLessThanOrEqual(4096);
  });
});

describe('fallBackToHeadless and the tick', () => {
  it('moves only an open pags run, re-queued with the reason and no claim', async () => {
    const { db, calls } = recordingDb();
    expect(await fallBackToHeadless(db, 'r1', 'pags_timeout')).toBe(true);
    expect(calls[0]!.sql).toContain("engine = 'headless', status = 'queued', fallback_reason = ?2, claimed_at = NULL");
    expect(calls[0]!.sql).toContain("engine = 'pags' AND status IN ('queued', 'running')");
    expect(await fallBackToHeadless(recordingDb(0).db, 'r1', 'x')).toBe(false);
  });

  it('the sweep names the quiet time, uses the longer allowance for a question, and nudges the executor once per app', async () => {
    const now = 10_000_000_000;
    const rows = [
      { run_id: 'a', app_id: 'club', pags_state: 'running', quiet_since: now - 20 * 60_000 },
      { run_id: 'b', app_id: 'club', pags_state: 'needs-you', quiet_since: now - 3 * 3600_000 },
      { run_id: 'c', app_id: 'other', pags_state: 'queued', quiet_since: now - 16 * 60_000 },
    ];
    const { db, calls } = recordingDb(1, rows);
    const nudges: string[] = [];
    const env = { DB: db, QA_WORKER: { fetch: vi.fn(async (u: string) => { nudges.push(u); return new Response('ok'); }) } } as unknown as Env;
    expect(await fallBackStalePagsRuns(env, now)).toBe(3);
    expect(calls[0]!.args).toEqual([now, PAGS_EVENT_TIMEOUT_MS, PAGS_NEEDS_YOU_TIMEOUT_MS]);
    const reasons = calls.slice(1).map((c) => c.args[1]);
    expect(reasons).toEqual(['pags_timeout: no event from the agent for 20 min', 'pags_needs_you_unanswered: no answer for 180 min', 'pags_timeout: no event from the agent for 16 min']);
    expect(nudges.sort()).toEqual(['https://qa-worker.internal/execute?app=club', 'https://qa-worker.internal/execute?app=other']);
  });

  it('nothing quiet means nothing moves and nothing is nudged', async () => {
    const { db } = recordingDb(1, []);
    const fetchSpy = vi.fn();
    expect(await fallBackStalePagsRuns({ DB: db, QA_WORKER: { fetch: fetchSpy } } as unknown as Env, 1)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await fallBackStalePagsRuns({ DB: db } as unknown as Env, 1)).toBe(0);
  });
});
