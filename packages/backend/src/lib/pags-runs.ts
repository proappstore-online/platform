/**
 * Run-state handling for the ProAgentStore verifier trial (#456): applying a signed
 * callback event to a run, and falling a run back to the headless executor when the
 * agent goes quiet. Shared by the callback route and the five-minute tick.
 */
import type { Env } from '../types.js';

export const PAGS_STATES = ['queued', 'running', 'needs-you', 'done', 'failed'] as const;
export type PagsState = (typeof PAGS_STATES)[number];

/** A queued or running pags run with no event for this long goes to the headless executor. */
export const PAGS_EVENT_TIMEOUT_MS = 15 * 60_000;
/** A run waiting on a person (needs-you) is given longer before it falls back. */
export const PAGS_NEEDS_YOU_TIMEOUT_MS = 2 * 60 * 60_000;
const DETAIL_MAX = 4096;

export interface PagsEvent {
  event_id: string;
  job_id: string;
  state: PagsState;
  note?: string | undefined;
  question?: string | undefined;
  report_url?: string | undefined;
  screenshots?: string[] | undefined;
  result?: { status?: string | undefined; steps_total?: number | undefined; steps_passed?: number | undefined; failed_step?: number | null | undefined; error?: string | null | undefined } | undefined;
}

const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 300) return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
};
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1_000_000 ? (v as number) : null);

/** Validate a callback body; returns the first problem or the event. */
export function parsePagsEvent(raw: unknown): { error: string } | { event: PagsEvent } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'body must be a JSON object' };
  const b = raw as Record<string, unknown>;
  if (typeof b.event_id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(b.event_id)) return { error: 'event_id must be 1-64 URL-safe characters' };
  if (typeof b.job_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(b.job_id)) return { error: 'job_id must be 1-128 URL-safe characters' };
  if (!PAGS_STATES.includes(b.state as PagsState)) return { error: `state must be one of ${PAGS_STATES.join(', ')}` };
  const r = b.result && typeof b.result === 'object' ? (b.result as Record<string, unknown>) : undefined;
  return {
    event: {
      event_id: b.event_id,
      job_id: b.job_id,
      state: b.state as PagsState,
      note: text(b.note, 500),
      question: text(b.question, 1000),
      report_url: httpsUrl(b.report_url) ?? undefined,
      screenshots: Array.isArray(b.screenshots) ? b.screenshots.map(httpsUrl).filter((u): u is string => u !== null).slice(0, 10) : undefined,
      result: r ? { status: text(r.status, 16), steps_total: int(r.steps_total) ?? undefined, steps_passed: int(r.steps_passed) ?? undefined, failed_step: r.failed_step === null ? null : int(r.failed_step), error: text(r.error, 500) ?? null } : undefined,
    },
  };
}

function detailJson(event: PagsEvent): string | null {
  const d = { note: event.note, question: event.question, report_url: event.report_url, screenshots: event.screenshots };
  const json = JSON.stringify(d);
  return json === '{}' ? null : json.slice(0, DETAIL_MAX).length === json.length ? json : JSON.stringify({ note: event.note?.slice(0, 200) });
}

/**
 * Apply one verified event to its run. Only an open pags run changes (a finished or
 * fallen-back run ignores late events); done and failed are final.
 * Returns whether a row changed.
 */
export async function applyPagsEvent(db: D1Database, jobId: string, event: PagsEvent, now: number): Promise<boolean> {
  const detail = detailJson(event);
  const open = "WHERE pags_job_id = ?1 AND engine = 'pags' AND status IN ('queued', 'running')";
  let res: D1Result;
  if (event.state === 'done') {
    const r = event.result;
    const status = r?.status === 'passed' || r?.status === 'failed' ? r.status : 'error';
    const error = status === 'error' ? 'the agent reported done without a pass/fail result' : r?.error ?? null;
    res = await db.prepare(
      `UPDATE app_test_runs SET status = ?2, steps_total = ?3, steps_passed = ?4, failed_step = ?5, error = ?6,
         pags_state = 'done', last_event_at = ?7, pags_detail = ?8, finished_at = ?7 ${open}`,
    ).bind(jobId, status, r?.steps_total ?? null, r?.steps_passed ?? null, r?.failed_step ?? null, error, now, detail).run();
  } else if (event.state === 'failed') {
    res = await db.prepare(
      `UPDATE app_test_runs SET status = 'error', error = ?2, pags_state = 'failed', last_event_at = ?3, pags_detail = ?4, finished_at = ?3 ${open}`,
    ).bind(jobId, event.result?.error ?? event.note ?? 'the agent run failed', now, detail).run();
  } else {
    // queued / running / needs-you keep the run open. A person's question waits as `running`.
    res = await db.prepare(
      `UPDATE app_test_runs SET status = ?2, pags_state = ?3, last_event_at = ?4, pags_detail = COALESCE(?5, pags_detail) ${open}`,
    ).bind(jobId, event.state === 'queued' ? 'queued' : 'running', event.state, now, detail).run();
  }
  return (res.meta?.changes ?? 0) > 0;
}

/** Hand a pags run to the headless executor, saying why. Only an open pags run moves. */
export async function fallBackToHeadless(db: D1Database, runId: string, reason: string): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE app_test_runs SET engine = 'headless', status = 'queued', fallback_reason = ?2, claimed_at = NULL
     WHERE run_id = ?1 AND engine = 'pags' AND status IN ('queued', 'running')`,
  ).bind(runId, reason).run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * The five-minute tick: pags runs whose agent has gone quiet run headlessly instead,
 * with the reason on the run, and the headless executor is nudged for those apps.
 */
export async function fallBackStalePagsRuns(env: Env, now: number): Promise<number> {
  const stale = await env.DB.prepare(
    `SELECT run_id, app_id, pags_state, COALESCE(last_event_at, started_at) AS quiet_since FROM app_test_runs
      WHERE engine = 'pags' AND status IN ('queued', 'running')
        AND COALESCE(last_event_at, started_at) < ?1 - CASE WHEN pags_state = 'needs-you' THEN ?3 ELSE ?2 END
      LIMIT 50`,
  ).bind(now, PAGS_EVENT_TIMEOUT_MS, PAGS_NEEDS_YOU_TIMEOUT_MS).all<{ run_id: string; app_id: string; pags_state: string | null; quiet_since: number }>();
  const apps = new Set<string>();
  let moved = 0;
  for (const r of stale.results ?? []) {
    const minutes = Math.round((now - r.quiet_since) / 60_000);
    const reason = r.pags_state === 'needs-you' ? `pags_needs_you_unanswered: no answer for ${minutes} min` : `pags_timeout: no event from the agent for ${minutes} min`;
    if (await fallBackToHeadless(env.DB, r.run_id, reason)) { moved++; apps.add(r.app_id); }
  }
  if (env.QA_WORKER) {
    for (const app of apps) await env.QA_WORKER.fetch(`https://qa-worker.internal/execute?app=${encodeURIComponent(app)}`, { method: 'POST' }).catch(() => {});
  }
  if (moved) console.warn(`[pags] ${moved} verifier run(s) fell back to the headless executor`);
  return moved;
}
