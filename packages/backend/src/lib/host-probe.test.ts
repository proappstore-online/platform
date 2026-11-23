import { describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../sqlite-d1.js';
import type { Env } from '../types.js';
import { ALWAYS, BURST, REALERT_MS, SAMPLE, hostProbeStatus, pickTargets, runHostProbe } from './host-probe.js';

// #656: concurrent bursts at live app roots from the backend cron, recorded in
// telemetry_health and alerted through host-probe-alert.yml.

const apps = ['meet', 'run', 'kanban', 'crm', 'jobs', 'ski'].map((id) => ({ id, appUrl: `https://${id}.proappstore.online` }));
const catalogue = () => Response.json({ apps });
const TICK = 5 * 60_000;

/** A fetch whose app roots answer `status(host)`, with catalogue.json and GitHub dispatches. */
function fakeFetch(status: (host: string) => number) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.hostname === 'proappstore.online') return catalogue();
    if (url.hostname === 'api.github.com') return new Response(null, { status: 204 });
    return new Response('x', { status: status(url.hostname.split('.')[0]!) });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const envWith = (extra: Partial<Env> = {}) => ({ DB: sqliteD1(), GITHUB_TOKEN: 'gh', ...extra }) as unknown as Env;

describe('pickTargets', () => {
  it('always takes run, plus a sample that rotates every tick', () => {
    const a = pickTargets(apps, 0).map((x) => x.id);
    const b = pickTargets(apps, TICK).map((x) => x.id);
    expect(a[0]).toBe(ALWAYS);
    expect(a).toHaveLength(SAMPLE + 1);
    expect(a.slice(1)).not.toContain(ALWAYS);
    expect(b.slice(1)).not.toEqual(a.slice(1));
    // Over enough ticks every app is probed.
    const seen = new Set(Array.from({ length: apps.length }, (_, i) => pickTargets(apps, i * TICK).map((x) => x.id)).flat());
    expect([...seen].sort()).toEqual(apps.map((x) => x.id).sort());
  });

  it('still probes run when the catalogue could not be read', () => {
    expect(pickTargets([], 0)).toEqual([{ id: 'run', appUrl: 'https://run.proappstore.online' }]);
  });
});

describe('runHostProbe', () => {
  it('sends overlapping bursts of BURST requests to each target root', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'proappstore.online') return catalogue();
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const env = envWith();
    const r = await runHostProbe({ env, now: 0, fetchImpl });
    expect(r).toEqual({ ok: true, error: null, dispatched: false });
    expect(peak).toBe(BURST);
    expect(vi.mocked(fetchImpl).mock.calls.filter(([u]) => String(u) === 'https://run.proappstore.online/')).toHaveLength(BURST);
    expect((await hostProbeStatus(env.DB)).ok).toBe(true);
  });

  it('records 5xx per app, publishes the status, and dispatches the alert workflow once per episode', async () => {
    const env = envWith();
    const { fetchImpl, calls } = fakeFetch((app) => (app === 'run' ? 500 : 200));
    const r = await runHostProbe({ env, now: 1_000, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`5xx:run=${BURST}/${BURST}`);
    expect(r.dispatched).toBe(true);
    expect(calls).toContain('https://api.github.com/repos/proappstore-online/platform/actions/workflows/host-probe-alert.yml/dispatches');
    expect(await hostProbeStatus(env.DB)).toMatchObject({ ok: false, lastFailureAt: 1_000, lastError: `5xx:run=${BURST}/${BURST}` });

    // Still failing five minutes later: the same episode, no second dispatch.
    expect((await runHostProbe({ env, now: 1_000 + TICK, fetchImpl })).dispatched).toBe(false);
    // A failure REALERT_MS after the last recorded one is a new episode.
    expect((await runHostProbe({ env, now: 1_000 + TICK + REALERT_MS, fetchImpl })).dispatched).toBe(true);
  });

  it('counts a failed fetch as a failure, and recovers on the next clean run', async () => {
    const env = envWith();
    const boom = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'proappstore.online') return catalogue();
      if (url.hostname === 'api.github.com') return new Response(null, { status: 204 });
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect((await runHostProbe({ env, now: 1_000, fetchImpl: boom })).ok).toBe(false);
    expect((await runHostProbe({ env, now: 2_000, fetchImpl: fakeFetch(() => 200).fetchImpl })).ok).toBe(true);
    expect(await hostProbeStatus(env.DB)).toMatchObject({ ok: true, lastOkAt: 2_000, lastFailureAt: 1_000 });
  });

  it('reports an unreadable catalogue and still probes run; no token, no dispatch', async () => {
    const env = envWith({ GITHUB_TOKEN: undefined });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).hostname === 'proappstore.online' ? new Response('down', { status: 503 }) : new Response('ok')) as unknown as typeof fetch;
    const r = await runHostProbe({ env, now: 0, fetchImpl });
    expect(r).toEqual({ ok: false, error: '5xx:catalogue', dispatched: false });
    expect(vi.mocked(fetchImpl).mock.calls.filter(([u]) => String(u) === 'https://run.proappstore.online/')).toHaveLength(BURST);
  });

  it('has no status before the first probe', async () => {
    expect(await hostProbeStatus(sqliteD1())).toEqual({ ok: null, lastOkAt: null, lastFailureAt: null, lastError: null, updatedAt: null });
  });
});
