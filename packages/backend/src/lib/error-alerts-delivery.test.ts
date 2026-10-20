import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_WINDOW_MS, CATCH_UP_MS, DISPATCH_LEASE_MS, ERROR_SPIKE_MIN, evaluateErrorSpikes } from './error-alerts.js';

// #389 on real SQLite (node:sqlite) built from every migration: the claim and
// stamp are conditional UPDATEs, so overlapping runs, restarts and repeats are
// decided by the database exactly as in D1. The adapter yields before every
// statement, so two runs started together interleave like two invocations; a
// "crash" is a statement that throws, ending that run where a dead isolate would.

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATIONS = new URL('../../../../migrations/', import.meta.url);

let sqlite: InstanceType<typeof DatabaseSync>;
let crashOn: RegExp | null = null;
const db = {
  prepare(sql: string) {
    const make = (args: unknown[]) => {
      const exec = async <T>(fn: () => T): Promise<T> => {
        await Promise.resolve();
        if (crashOn?.test(sql)) throw new Error('isolate killed');
        return fn();
      };
      return {
        bind: (...a: unknown[]) => make(a),
        first: () => exec(() => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null),
        all: () => exec(() => ({ results: sqlite.prepare(sql).all(...(args as never[])) })),
        run: () => exec(() => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } })),
      };
    };
    return make([]);
  },
} as unknown as D1Database;
const env = { DB: db };

// A quarter-hour boundary: [Q - 15m, Q) has just completed at Q.
const Q = 1_800_000_000_000 + ALERT_WINDOW_MS;
const PREV = Q - ALERT_WINDOW_MS;
const MIN = 60_000;
let sends: { app_id: string; kind: string; window_start: number }[];

/** A client-error spike of `half` × 2 in the interval ending at `end` (25 by default, over ERROR_SPIKE_MIN). */
function spike(app: string, end: number, half = (ERROR_SPIKE_MIN + 5) / 2) {
  const ins = sqlite.prepare("INSERT INTO app_metric_buckets (app_id, bucket_start, signal, n) VALUES (?, ?, 'client_error', ?)");
  ins.run(app, end - 15 * MIN, Math.ceil(half));
  ins.run(app, end - 10 * MIN, Math.floor(half));
}
const alerts = () => sqlite.prepare('SELECT app_id, kind, window_start, dispatched_at, dispatch_claimed_at FROM app_alerts ORDER BY window_start').all() as Record<string, unknown>[];
const tick = (at: number) => evaluateErrorSpikes({ env, now: at });

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  sqlite.prepare("INSERT INTO app_webhooks (id, app_id, event, url, secret, active, created_at) VALUES ('h1', 'shop', 'app.alert', 'https://hooks.example/alert', 's3cret', 1, 0)").run();
  crashOn = null;
  sends = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    sends.push({ app_id: body.app_id, kind: body.kind, window_start: body.window_start });
    return new Response(null, { status: 204 });
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('alert delivery across ticks, overlaps and restarts (#389)', () => {
  it('missed ticks within the horizon: the first tick after them records and delivers the interval', async () => {
    spike('shop', Q);
    // The ticks at Q .. Q+15m never ran; the next one is 20 minutes late.
    const r = await tick(Q + 20 * MIN);
    expect(r).toMatchObject({ recorded: 1, dispatched: 1 });
    expect(sends).toEqual([{ app_id: 'shop', kind: 'error_spike', window_start: PREV }]);
  });

  it('overlapping catch-up ranges across consecutive ticks: one row and one delivery per interval', async () => {
    spike('shop', Q);
    spike('shop', Q + ALERT_WINDOW_MS, 40); // 80: a spike over the first interval's 25 too
    // Every interval is in range for several ticks (CATCH_UP_MS / 5 min of them).
    for (let at = Q; at <= Q + ALERT_WINDOW_MS + CATCH_UP_MS - MIN; at += 5 * MIN) await tick(at);
    expect(alerts().map((a) => a.window_start)).toEqual([PREV, Q]);
    expect(sends.map((s) => s.window_start)).toEqual([PREV, Q]);
  });

  it('two evaluations at once (a slow tick and the next, or a tick and an owner run): one row, one delivery', async () => {
    spike('shop', Q);
    const [a, b] = await Promise.all([tick(Q), evaluateErrorSpikes({ env, now: Q + 1, appId: 'shop' })]);
    expect(a.recorded + b.recorded).toBe(1);
    expect(a.dispatched + b.dispatched).toBe(1);
    expect(alerts()).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });

  it('restart between record and dispatch: the next tick delivers it, once', async () => {
    spike('shop', Q);
    crashOn = /SET dispatch_claimed_at/;
    await expect(tick(Q)).rejects.toThrow('isolate killed');
    expect(alerts()[0]).toMatchObject({ dispatched_at: null, dispatch_claimed_at: null });
    expect(sends).toHaveLength(0);

    crashOn = null;
    const r = await tick(Q + 5 * MIN);
    expect(r).toMatchObject({ recorded: 0, dispatched: 1 });
    expect(sends).toHaveLength(1);
    expect(alerts()[0]!.dispatched_at).toBe(Q + 5 * MIN);
    await tick(Q + 10 * MIN);
    expect(sends).toHaveLength(1);
  });

  it('restart mid-send: not resent while the claim holds, resent once after the lease', async () => {
    spike('shop', Q);
    // The send went out; the run died before stamping it.
    crashOn = /SET dispatched_at/;
    await expect(tick(Q)).rejects.toThrow('isolate killed');
    expect(sends).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ dispatched_at: null, dispatch_claimed_at: Q });

    crashOn = null;
    await tick(Q + 5 * MIN);
    expect(sends).toHaveLength(1);
    await tick(Q + DISPATCH_LEASE_MS);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
    await tick(Q + DISPATCH_LEASE_MS + 5 * MIN);
    expect(sends).toHaveLength(2);
  });

  it('no resend once dispatched, however often the interval is evaluated again', async () => {
    spike('shop', Q);
    for (let i = 0; i < 6; i++) await tick(Q + i * MIN);
    expect(sends).toHaveLength(1);
  });

  it('a redelivery carries the same payload as the first send would have', async () => {
    spike('shop', Q);
    const bodies: unknown[] = [];
    vi.mocked(fetch).mockImplementation(async (_u, init) => { bodies.push(JSON.parse(String((init as RequestInit).body))); return new Response(null, { status: 204 }); });
    crashOn = /SET dispatch_claimed_at/;
    await expect(tick(Q)).rejects.toThrow();
    crashOn = null;
    await tick(Q + 5 * MIN);
    expect(bodies[0]).toMatchObject({
      event: 'app.alert', app_id: 'shop', kind: 'error_spike', window_start: PREV, window_end: Q, count: 25,
      detail_basis: 'retained_rows_sample', detected_at: Q,
    });
  });

  it("leaves other writers' alerts to their own dispatch", async () => {
    sqlite.prepare("INSERT INTO app_alerts (app_id, kind, window_start, window_end, count, created_at) VALUES ('shop', 'app_worker_quota', ?, ?, 1, ?)").run(PREV, Q, Q - MIN);
    await tick(Q);
    expect(sends).toHaveLength(0);
  });
});

describe('the recorded gap: scheduled runs keep a cursor (#389)', () => {
  const sched = (at: number) => evaluateErrorSpikes({ env, now: at, scheduled: true });
  const cursor = () => sqlite.prepare("SELECT last_window_end, gap_start, gap_end, gap_recorded_at FROM alert_evaluator_cursor WHERE id = 'scheduled'").get() as Record<string, number | null> | undefined;
  const health = () => sqlite.prepare("SELECT last_failure_at, last_error FROM telemetry_health WHERE component = 'evaluator'").get() as Record<string, unknown> | undefined;

  it('the first run sets it; runs every five minutes, or up to CATCH_UP_MS apart, record no gap', async () => {
    expect((await sched(Q)).gap).toBeNull();
    expect(cursor()).toMatchObject({ last_window_end: Q, gap_start: null });
    expect((await sched(Q + 5 * MIN)).gap).toBeNull();
    expect((await sched(Q + 5 * MIN + CATCH_UP_MS)).gap).toBeNull();
    expect(cursor()!.last_window_end).toBe(Q + 5 * MIN + CATCH_UP_MS);
    expect(health()).toBeUndefined();
  });

  it('a longer outage records the unevaluated range once, flags the evaluator and replays nothing from it', async () => {
    await sched(Q);
    // An error spike inside the outage, in the interval [Q, Q+15m): its evaluation chance passes unseen.
    spike('shop', Q + ALERT_WINDOW_MS);
    const late = Q + 60 * MIN;
    const r = await sched(late);
    // Covered now: the slices ending in (late - 30m, late], i.e. from late - 30m.
    expect(r.gap).toEqual({ start: Q, end: late - CATCH_UP_MS });
    expect(cursor()).toMatchObject({ last_window_end: late, gap_start: Q, gap_end: late - CATCH_UP_MS, gap_recorded_at: late });
    expect(health()).toMatchObject({ last_error: 'gap', last_failure_at: late });
    expect(alerts()).toHaveLength(0);
    expect(sends).toHaveLength(0);
    // The next on-time run finds no new gap and keeps the last one on record.
    expect((await sched(late + 5 * MIN)).gap).toBeNull();
    expect(cursor()).toMatchObject({ gap_start: Q, gap_end: late - CATCH_UP_MS });
  });

  it('overlapping or out-of-order runs never rewind the cursor or invent a gap', async () => {
    await sched(Q + 10 * MIN);
    await Promise.all([sched(Q + 15 * MIN), sched(Q + 5 * MIN)]);
    expect(cursor()).toMatchObject({ last_window_end: Q + 15 * MIN, gap_start: null });
  });

  it("an owner's on-demand run does not move the cursor", async () => {
    await sched(Q);
    await evaluateErrorSpikes({ env, now: Q + 2 * 60 * MIN, appId: 'shop', scheduled: true });
    await evaluateErrorSpikes({ env, now: Q + 2 * 60 * MIN, appId: 'shop' });
    expect(cursor()!.last_window_end).toBe(Q);
  });
});
