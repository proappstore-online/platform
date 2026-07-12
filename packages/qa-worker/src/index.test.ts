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
      { waitUntil: 'networkidle0', timeout: 30_000 },
    );
  });
});
