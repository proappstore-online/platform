/**
 * TEMPORARY (#305): measurement harness for the Dynamic Workers spike. Removed
 * in the commit that records the results. Internal-token only; touches no D1,
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
import { internalTokenOk } from '@proappstore/build-core';
import type { Env } from '../types.js';

export const appWorkerSpikeRoutes = new Hono<{ Bindings: Env }>();

const waiter = `export default { async fetch(req) {
  const { sleepMs } = await req.json();
  const startedAt = Date.now();
  await new Promise((r) => setTimeout(r, sleepMs));
  return Response.json({ startedAt, finishedAt: Date.now() });
} };`;

function sizedModule(kb: number, spinMs: number): string {
  const parts = ['const registry = {};'];
  for (let i = 0; parts.join('\n').length < kb * 1024; i++) {
    parts.push(`registry.f${i} = function f${i}(a, b) { const t = { id: ${i}, tags: ['x${i}', 'y${i}'], next: (v) => v * ${i + 1} + (a ?? 0) }; return t.next(b ?? ${i}) + t.tags.length; };`);
  }
  parts.push(`const spinUntil = Date.now(); let acc = 0; for (let i = 0; i < ${spinMs} * 40000; i++) acc += Math.sqrt(i);`);
  parts.push(`export default { fetch() { return Response.json({ fns: Object.keys(registry).length, acc: acc > 0 }); } };`);
  return parts.join('\n');
}

appWorkerSpikeRoutes.post('/internal/app-worker-spike', async (c) => {
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) return c.json({ error: 'forbidden' }, 403);
  const loader = c.env.LOADER;
  if (!loader) return c.json({ error: 'no LOADER binding' }, 503);
  const body = await c.req.json<{ mode?: string; n?: number; sleepMs?: number; kb?: number; spinMs?: number }>();
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
    const source = sizedModule(kb, Math.min(Math.max(body.spinMs ?? 0, 0), 2000));
    const worker = loader.get(`spike:${run}:startup`, async () => ({
      compatibilityDate: '2026-01-01', mainModule: 'w.js', modules: { 'w.js': source }, env: {}, globalOutbound: null,
    }));
    const res = await worker.getEntrypoint().fetch(new Request('https://w.invalid/'));
    return c.json({ run, bytes: source.length, kb, spinMs: body.spinMs ?? 0, wallMs: Date.now() - t0, child: await res.json() });
  }
  return c.json({ error: 'mode must be fanout or startup' }, 400);
});
