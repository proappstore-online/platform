import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
}));

vi.mock('@cloudflare/puppeteer', () => ({
  default: { launch: mocks.launch },
}));

import worker from './index.js';

function stmt(opts: { all?: unknown; first?: unknown; run?: unknown } = {}) {
  return {
    sql: '',
    args: [] as unknown[],
    bind: vi.fn(function bind(this: { args: unknown[] }, ...args: unknown[]) {
      this.args = args;
      return this;
    }),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 1 } }),
  };
}

function dbWithStatements(statements: ReturnType<typeof stmt>[]) {
  const prepare = vi.fn((sql: string) => {
    const next = statements.shift() ?? stmt();
    next.sql = sql;
    return next;
  });
  return { prepare };
}

function executionCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as unknown as ExecutionContext,
    async flush() { await Promise.all(pending); },
  };
}

function fakeBrowser() {
  const page = {
    setViewport: vi.fn(),
    goto: vi.fn(),
    evaluate: vi.fn(async (arg: unknown) => (typeof arg === 'function' ? { ok: true } : undefined)),
    screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
    close: vi.fn(async () => {}),
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  };
  return {
    createBrowserContext: vi.fn(async () => context),
    close: vi.fn(async () => {}),
    page,
    context,
  };
}

describe('qa-worker run claiming', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.launch.mockReset();
  });

  it('uses claim time, not queue time, for stale running recovery', async () => {
    const stale = stmt();
    const queued = stmt({ all: { results: [] } });
    const db = dbWithStatements([stale, queued]);
    const { ctx, flush } = executionCtx();

    await worker.fetch(new Request('https://qa-worker.internal/execute', { method: 'POST' }), {
      DB: db as unknown as D1Database,
      BROWSER: {} as Fetcher,
      STORAGE: {} as R2Bucket,
    }, ctx);
    await flush();

    expect(stale.sql).toContain('COALESCE(claimed_at, started_at)');
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('sets claimed_at when claiming an old queued run before executing it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
    const browser = fakeBrowser();
    mocks.launch.mockResolvedValue(browser);

    const stale = stmt();
    const queued = stmt({ all: { results: [{ run_id: 'run-1', app_id: 'chess-academy', flow_id: 'smoke' }] } });
    const claim = stmt({ run: { meta: { changes: 1 } } });
    const flow = stmt({ first: { spec: JSON.stringify({ id: 'smoke', name: 'Smoke', steps: [{ op: 'expectText', text: 'Sign in' }] }) } });
    const finish = stmt();
    const db = dbWithStatements([stale, queued, claim, flow, finish]);
    const storage = { put: vi.fn() };
    const { ctx, flush } = executionCtx();

    await worker.fetch(new Request('https://qa-worker.internal/execute?app=chess-academy', { method: 'POST' }), {
      DB: db as unknown as D1Database,
      BROWSER: {} as Fetcher,
      STORAGE: storage as unknown as R2Bucket,
    }, ctx);
    await flush();

    expect(claim.sql).toContain("SET status = 'running', claimed_at = ?2");
    expect(claim.bind).toHaveBeenCalledWith('run-1', Date.parse('2026-07-13T00:00:00Z'));
    expect(browser.page.goto).toHaveBeenCalledWith(
      expect.stringContaining('https://chess-academy.proappstore.online/?__qa_bust='),
      // `load`, not networkidle0 — apps with a long-lived WS/SSE never idle.
      { waitUntil: 'load', timeout: 30_000 },
    );
  });
});

// #62: a deploy batch must not run serially inside one invocation. With SELF
// bound, each invocation takes one run and re-nudges itself while more wait.
describe('qa-worker one-run-per-invocation chain (#62)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.launch.mockReset();
  });

  const row = (id: string) => ({ run_id: id, app_id: 'chess-academy', flow_id: id });
  const flowSpec = { first: { spec: JSON.stringify({ id: 'f', name: 'F', steps: [{ op: 'expectText', text: 'x' }] }) } };

  it('executes exactly one run, then re-nudges SELF for the same app because more are queued', async () => {
    const browser = fakeBrowser();
    mocks.launch.mockResolvedValue(browser);
    const stale = stmt();
    const queued = stmt({ all: { results: [row('run-1')] } }); // LIMIT 1 → one row back
    const claim = stmt({ run: { meta: { changes: 1 } } });
    const flow = stmt(flowSpec);
    const finish = stmt();
    const remaining = stmt({ all: { results: [row('run-2')] } });
    const db = dbWithStatements([stale, queued, claim, flow, finish, remaining]);
    const self = { fetch: vi.fn(async () => Response.json({ ok: true })) };
    const { ctx, flush } = executionCtx();

    await worker.fetch(new Request('https://qa-worker.internal/execute?app=chess-academy', { method: 'POST' }), {
      DB: db as unknown as D1Database, BROWSER: {} as Fetcher, STORAGE: { put: vi.fn() } as unknown as R2Bucket, SELF: self as unknown as Fetcher,
    }, ctx);
    await flush();

    expect(queued.bind).toHaveBeenCalledWith('chess-academy', 1); // one per invocation
    expect(browser.createBrowserContext).toHaveBeenCalledTimes(1);
    expect(self.fetch).toHaveBeenCalledTimes(1);
    expect(self.fetch.mock.calls[0]![0]).toBe('https://qa-worker.internal/execute?app=chess-academy');
    expect(self.fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    // The browser is closed BEFORE the next invocation is asked for.
    expect(browser.close.mock.invocationCallOrder[0]!).toBeLessThan(self.fetch.mock.invocationCallOrder[0]!);
  });

  it('does not re-nudge when the queue is empty after its run', async () => {
    const browser = fakeBrowser();
    mocks.launch.mockResolvedValue(browser);
    const db = dbWithStatements([stmt(), stmt({ all: { results: [row('run-1')] } }), stmt(), stmt(flowSpec), stmt(), stmt({ all: { results: [] } })]);
    const self = { fetch: vi.fn() };
    const { ctx, flush } = executionCtx();
    await worker.fetch(new Request('https://qa-worker.internal/execute?app=chess-academy', { method: 'POST' }), {
      DB: db as unknown as D1Database, BROWSER: {} as Fetcher, STORAGE: { put: vi.fn() } as unknown as R2Bucket, SELF: self as unknown as Fetcher,
    }, ctx);
    await flush();
    expect(self.fetch).not.toHaveBeenCalled();
  });

  it('on the cron (no app) it takes one run from any app and re-nudges without an app filter', async () => {
    const browser = fakeBrowser();
    mocks.launch.mockResolvedValue(browser);
    const queued = stmt({ all: { results: [row('run-1')] } });
    const db = dbWithStatements([stmt(), queued, stmt(), stmt(flowSpec), stmt(), stmt({ all: { results: [row('run-2')] } })]);
    const self = { fetch: vi.fn(async () => Response.json({ ok: true })) };
    const ctx = executionCtx();
    await worker.scheduled({} as ScheduledEvent, {
      DB: db as unknown as D1Database, BROWSER: {} as Fetcher, STORAGE: { put: vi.fn() } as unknown as R2Bucket, SELF: self as unknown as Fetcher,
    }, ctx.ctx);
    await ctx.flush();
    expect(queued.bind).toHaveBeenCalledWith(1);
    expect(self.fetch.mock.calls[0]![0]).toBe('https://qa-worker.internal/execute');
  });

  it('a failed self-nudge is logged and leaves the run for the cron — never thrown', async () => {
    const browser = fakeBrowser();
    mocks.launch.mockResolvedValue(browser);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = dbWithStatements([stmt(), stmt({ all: { results: [row('run-1')] } }), stmt(), stmt(flowSpec), stmt(), stmt({ all: { results: [row('run-2')] } })]);
    const self = { fetch: vi.fn(async () => { throw new Error('binding down'); }) };
    const { ctx, flush } = executionCtx();
    await worker.fetch(new Request('https://qa-worker.internal/execute?app=chess-academy', { method: 'POST' }), {
      DB: db as unknown as D1Database, BROWSER: {} as Fetcher, STORAGE: { put: vi.fn() } as unknown as R2Bucket, SELF: self as unknown as Fetcher,
    }, ctx);
    await expect(flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('self-nudge failed'));
    warn.mockRestore();
  });

  it('without SELF it falls back to a short serial batch, so nothing is left queued', async () => {
    const browser = fakeBrowser();
    mocks.launch.mockResolvedValue(browser);
    const queued = stmt({ all: { results: [row('run-1'), row('run-2')] } });
    const db = dbWithStatements([stmt(), queued, stmt(), stmt(flowSpec), stmt(), stmt(), stmt(flowSpec), stmt()]);
    const { ctx, flush } = executionCtx();
    await worker.fetch(new Request('https://qa-worker.internal/execute?app=chess-academy', { method: 'POST' }), {
      DB: db as unknown as D1Database, BROWSER: {} as Fetcher, STORAGE: { put: vi.fn() } as unknown as R2Bucket,
    }, ctx);
    await flush();
    expect(queued.bind).toHaveBeenCalledWith('chess-academy', 3);
    expect(browser.createBrowserContext).toHaveBeenCalledTimes(2);
  });
});
