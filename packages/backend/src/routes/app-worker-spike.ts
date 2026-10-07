/**
 * TEMPORARY (#305): measurement harness for the Dynamic Workers spike. Removed
 * in the commit that records the results. Platform-admin session only; touches no D1,
 * R2 or app data, and the workers it loads have no env and no egress.
 *
 *   POST /internal/app-worker-spike  { mode: 'fanout', n, sleepMs }
 *     Loads `n` distinct Dynamic Workers at once from this one request and has each
 *     wait `sleepMs`. Answers when each started and finished, relative to the
 *     request, so the per-request concurrency cap shows as a staircase.
 *   POST /internal/app-worker-spike  { mode: 'startup', kb, spinMs? }
 *     Cold-loads one fresh Dynamic Worker whose module is about `kb` KB of source
 *     (and burns `spinMs` of CPU, to show the parent's CPU time includes the
 *     child's). Run it under `wrangler tail` to read the request's CPU time.
 */
import { Hono } from 'hono';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { requireAdmin } from '../lib/auth.js';
import type { Env } from '../types.js';

/** Tail Worker for the harness's dynamic workers: files each run's CPU, wall time and logs in R2 under `_spike/<label>`. */
export class SpikeTail extends WorkerEntrypoint<Env, { label: string }> {
  override async tail(events: TraceItem[]): Promise<void> {
    const rows = events.map((e) => ({
      cpuTime: e.cpuTime, wallTime: e.wallTime, outcome: e.outcome, entrypoint: e.entrypoint ?? null,
      logs: e.logs.map((l) => l.message), exceptions: e.exceptions.map((x) => x.message),
    }));
    await this.env.STORAGE.put(`_spike/${(this.ctx as unknown as { props: { label: string } }).props.label}`, JSON.stringify(rows));
  }
}

async function readTail(env: Env, label: string): Promise<unknown> {
  for (let i = 0; i < 20; i++) {
    const obj = await env.STORAGE.get(`_spike/${label}`);
    if (obj) { const rows = await obj.json(); await env.STORAGE.delete(`_spike/${label}`); return rows; }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export const appWorkerSpikeRoutes = new Hono<{ Bindings: Env }>();

const waiter = `export default { async fetch(req) {
  const { sleepMs } = await req.json();
  const startedAt = Date.now();
  await new Promise((r) => setTimeout(r, sleepMs));
  return Response.json({ startedAt, finishedAt: Date.now() });
} };`;

function sizedModule(kb: number, spinMs: number, spinIn: string): string {
  const parts = ['const registry = {};'];
  let size = parts[0]!.length;
  for (let i = 0; size < kb * 1024; i++) {
    const fn = `registry.f${i} = function f${i}(a, b) { const t = { id: ${i}, tags: ['x${i}', 'y${i}'], next: (v) => v * ${i + 1} + (a ?? 0) }; return t.next(b ?? ${i}) + t.tags.length; };`;
    parts.push(fn);
    size += fn.length + 1;
  }
  const spin = `let acc = 0; for (let i = 0; i < ${spinMs} * 40000; i++) acc += Math.sqrt(i);`;
  parts.push(spinIn === 'fetch' ? 'let acc = 0;' : spin);
  parts.push(`export default { fetch() { ${spinIn === 'fetch' ? spin.replace('let acc = 0; ', '') : ''} console.log('spike-child-log ' + Object.keys(registry).length); return Response.json({ fns: Object.keys(registry).length, acc: acc > 0 }); } };`);
  return parts.join('\n');
}

appWorkerSpikeRoutes.post('/internal/app-worker-spike', async (c) => {
  await requireAdmin(c);
  const loader = c.env.LOADER;
  if (!loader) return c.json({ error: 'no LOADER binding' }, 503);
  const body = await c.req.json<{ mode?: string; n?: number; sleepMs?: number; kb?: number; spinMs?: number; cpuMs?: number; spinIn?: string; tail?: boolean; entrypointLimit?: boolean }>();
  const run = crypto.randomUUID();
  const t0 = Date.now();

  if (body.mode === 'fanout') {
    const n = Math.min(Math.max(body.n ?? 6, 1), 12);
    const sleepMs = Math.min(Math.max(body.sleepMs ?? 3000, 0), 10_000);
    const results = await Promise.all(Array.from({ length: n }, async (_, i) => {
      const worker = loader.get(`spike:${run}:${i}`, async () => ({
        compatibilityDate: '2026-01-01', mainModule: 'w.js', modules: { 'w.js': waiter }, env: {}, globalOutbound: null,
      }));
      const requestedAt = Date.now() - t0;
      try {
        const res = await worker.getEntrypoint().fetch(new Request('https://w.invalid/', { method: 'POST', body: JSON.stringify({ sleepMs }) }));
        const r = await res.json<{ startedAt: number; finishedAt: number }>();
        return { i, requestedAt, startedAt: r.startedAt - t0, finishedAt: r.finishedAt - t0, doneAt: Date.now() - t0 };
      } catch (e) {
        return { i, requestedAt, error: String((e as Error).message ?? e), doneAt: Date.now() - t0 };
      }
    }));
    return c.json({ run, n, sleepMs, totalMs: Date.now() - t0, results });
  }

  if (body.mode === 'startup') {
    const kb = Math.min(Math.max(body.kb ?? 200, 0), 3000);
    const source = sizedModule(kb, Math.min(Math.max(body.spinMs ?? 0, 0), 2000), body.spinIn ?? 'startup');
    const worker = loader.get(`spike:${run}:startup`, async () => ({
      compatibilityDate: '2026-01-01', mainModule: 'w.js', modules: { 'w.js': source }, env: {}, globalOutbound: null,
      ...(body.cpuMs && !body.entrypointLimit ? { limits: { cpuMs: body.cpuMs } } : {}),
      ...(body.tail ? { tails: [(c.executionCtx as unknown as { exports: { SpikeTail(o: { props: { label: string } }): Fetcher } }).exports.SpikeTail({ props: { label: run } })] } : {}),
    }));
    try {
      const res = await (body.entrypointLimit ? worker.getEntrypoint(undefined, { limits: { cpuMs: body.cpuMs ?? 0 } }) : worker.getEntrypoint()).fetch(new Request('https://w.invalid/'));
      return c.json({ run, bytes: source.length, kb, spinMs: body.spinMs ?? 0, cpuMs: body.cpuMs ?? null, wallMs: Date.now() - t0, status: res.status, child: await res.text(), ...(body.tail ? { tail: await readTail(c.env, run) } : {}) });
    } catch (e) {
      return c.json({ run, bytes: source.length, kb, spinMs: body.spinMs ?? 0, cpuMs: body.cpuMs ?? null, wallMs: Date.now() - t0, error: String((e as Error).message ?? e), ...(body.tail ? { tail: await readTail(c.env, run) } : {}) });
    }
  }

  if (body.mode === 'waves') {
    // n workers, at most 4 in flight: each starts as one finishes. Shows a freed slot is reusable in the same request.
    const n = Math.min(Math.max(body.n ?? 8, 1), 12);
    const sleepMs = Math.min(Math.max(body.sleepMs ?? 1000, 0), 10_000);
    const results: unknown[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < n) {
        const i = next++;
        const worker = loader.get(`spike:${run}:${i}`, async () => ({
          compatibilityDate: '2026-01-01', mainModule: 'w.js', modules: { 'w.js': waiter }, env: {}, globalOutbound: null,
        }));
        const startedAt = Date.now() - t0;
        try {
          await (await worker.getEntrypoint().fetch(new Request('https://w.invalid/', { method: 'POST', body: JSON.stringify({ sleepMs }) }))).text();
          results.push({ i, startedAt, doneAt: Date.now() - t0 });
        } catch (e) {
          results.push({ i, startedAt, error: String((e as Error).message ?? e) });
        }
      }
    }));
    return c.json({ run, n, sleepMs, totalMs: Date.now() - t0, results });
  }
  return c.json({ error: 'mode must be fanout, waves or startup' }, 400);
});
