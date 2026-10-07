/**
 * #308: what an app worker did during an invocation, from its Tail Worker.
 *
 * The loader runs the app in a dynamic worker whose `console` output never
 * reaches proappstore-api's own logs and whose CPU is not in the parent's
 * `cpuTime` (#305). `AppWorkerTail` (rpc/app-worker-tail.ts) is attached through
 * `WorkerCode.tails`, so the runtime hands it one TraceItem per invocation, after
 * the invocation ends.
 *
 * Which invocation: the loader ID — and so the WorkerCode, tails included — is
 * cached across invocations, so the tail's props can only carry the app. The
 * invocation id travels on the invoke request as `x-pas-invocation`, set by
 * `invoke()` (never by the app), and is read back from the trace's request.
 * The UPDATE matches the app from props too, so a trace can only ever land on
 * an invocation of the app the tail was attached for.
 *
 * Writes: child_cpu_ms / child_wall_ms / child_outcome on the invocation row,
 * and the console lines and exceptions into app_logs (category `worker`, source
 * `worker-console`, trace_id = the invocation id), within the app's log quota.
 */
import type { Env } from '../types.js';
import { INVOCATION_HEADER } from './app-worker-host.js';
import { insertWorkerLog } from './app-worker-calls.js';
import { checkLogQuota, d1LogUsageStore } from './log-quota.js';
import { normalizeEntry, type Level, type NormalizedEntry } from './log-ingest.js';

/** Console lines and exceptions kept per invocation; the rest are dropped, and one line says how many. */
export const MAX_TAIL_LINES = 100;
const INVOCATION_RE = /^.{1,300}:\d{1,9}$/;
const LEVEL_OF: Record<string, Level> = { debug: 'debug', log: 'info', info: 'info', warn: 'warn', error: 'error' };

/** The invocation a trace belongs to, from the request `invoke()` sent; null for anything else. */
export function invocationOf(item: TraceItem): string | null {
  const event = item.event as TraceItemFetchEventInfo | null;
  if (!event || !('request' in event) || !event.request) return null;
  const id = event.request.headers?.[INVOCATION_HEADER] ?? event.request.getUnredacted?.().headers?.[INVOCATION_HEADER];
  return typeof id === 'string' && INVOCATION_RE.test(id) ? id : null;
}

/** One console call's arguments as one line. */
function lineOf(message: unknown): string {
  const parts = Array.isArray(message) ? message : [message];
  return parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p) ?? String(p))).join(' ');
}

interface Line { level: Level; message: string; ts: number }

export function linesOf(item: TraceItem): Line[] {
  const lines: Line[] = [
    ...(item.logs ?? []).map((l) => ({ level: LEVEL_OF[l.level] ?? 'info', message: lineOf(l.message), ts: l.timestamp })),
    ...(item.exceptions ?? []).map((e) => ({ level: 'error' as const, message: `${e.name}: ${e.message}`, ts: e.timestamp })),
  ].sort((a, b) => a.ts - b.ts);
  if (lines.length <= MAX_TAIL_LINES) return lines;
  const kept = lines.slice(0, MAX_TAIL_LINES - 1);
  return [...kept, { level: 'warn', message: `${lines.length - kept.length} more console lines dropped (max ${MAX_TAIL_LINES} per invocation)`, ts: kept.at(-1)!.ts }];
}

/** Record every trace that names one of `appId`'s invocations. Never throws: a tail has nobody to report to. */
export async function recordTail(env: Env, appId: string, items: TraceItem[], now = Date.now()): Promise<void> {
  for (const item of items) {
    const invocation = invocationOf(item);
    if (!invocation) continue;
    try {
      const row = await env.DB.prepare(
        `UPDATE app_worker_invocations SET child_cpu_ms = ?, child_wall_ms = ?, child_outcome = ?
          WHERE id = ? AND app_id = ? RETURNING id`,
      ).bind(Math.round(item.cpuTime ?? 0), Math.round(item.wallTime ?? 0), item.outcome ?? null, invocation, appId).first();
      if (!row) continue;
      const entries = (await Promise.all(linesOf(item).map((l) =>
        normalizeEntry({ level: l.level, category: 'worker', message: l.message, ts: l.ts }, now)))).filter((e): e is NormalizedEntry => e !== null);
      if (!entries.length) continue;
      const verdict = await checkLogQuota(d1LogUsageStore(env.DB), { appId, clientKey: 'app-worker', entries: entries.length, nowMs: now });
      if (!verdict.persist) continue;
      await env.DB.batch(entries.map((e) => insertWorkerLog(env, appId, e, invocation, 'worker-console', now)));
    } catch (e) {
      console.error(`[app-worker-tail] recording ${invocation} failed: ${(e as Error)?.message ?? e}`);
    }
  }
}
