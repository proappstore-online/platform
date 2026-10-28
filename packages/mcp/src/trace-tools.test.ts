import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/** The owner-only get_action_trace tool (#502): the exact backend call, refusals, and what the summary shows and withholds. */

type Result = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools = new Map<string, { schema: z.ZodRawShape; annotations: Record<string, unknown>; handler: Handler }>();
const fakeServer = {
  tool: (name: string, _d: string, schema: z.ZodRawShape, annotations: Record<string, unknown>, handler: Handler) => {
    tools.set(name, { schema, annotations, handler });
  },
};

const apiFetch = vi.fn();
const env = {
  API_BASE: 'https://api.test.com',
  API: { fetch: apiFetch } as unknown as Fetcher,
  OAUTH_KV: { put: vi.fn() } as unknown as KVNamespace,
} as Record<string, unknown>;

const { registerTraceTools, summariseTrace, sqliteErrorClass, sqliteObject } = await import('./trace-tools.js');
let userCtx: { userId: string | null; token: string | null } = { userId: 'gh:1', token: 'tok-1' };
registerTraceTools(fakeServer as never, env as never, () => userCtx);

const TRACE = '2f962b9b075d2343db36486eeb0c415d';
const call = (args: Record<string, unknown> = { app_id: 'bookkeeper', trace_id: TRACE }) => tools.get('get_action_trace')!.handler(args);
const body = (r: Result) => JSON.parse(r.content[0]!.text) as Record<string, any>;
const reply = (b: unknown, status = 200) => apiFetch.mockResolvedValueOnce(new Response(typeof b === 'string' ? b : JSON.stringify(b), { status }));

const tenantRow = {
  ts: Date.UTC(2026, 9, 27, 3, 0, 0), hop: 'api', source: 'server', level: 'warn', category: 'action',
  message: 'data worker returned 500 (tenant fault): no such column: totl_cents: SQLITE_ERROR',
  data: { operation: 'add_open_question', status: 500, fault: 'tenant', route: '/v1/apps/:appId/actions/:name' },
  context: { v: 1, operation: 'add_open_question', result: 'error', spanId: 'a'.repeat(16), errorCode: 'internal_error' },
};

beforeEach(() => {
  vi.clearAllMocks();
  userCtx = { userId: 'gh:1', token: 'tok-1' };
});

describe('get_action_trace (#502)', () => {
  it('is one read-only tool, and slug/id-checks what it puts in the backend path', () => {
    expect([...tools.keys()]).toEqual(['get_action_trace']);
    expect(tools.get('get_action_trace')!.annotations.readOnlyHint).toBe(true);
    const s = z.object(tools.get('get_action_trace')!.schema);
    expect(s.safeParse({ app_id: 'bookkeeper', trace_id: TRACE }).success).toBe(true);
    expect(s.safeParse({ app_id: '../admin', trace_id: TRACE }).success).toBe(false);
    expect(s.safeParse({ app_id: 'bookkeeper', trace_id: '../x' }).success).toBe(false);
    expect(s.safeParse({ app_id: 'bookkeeper', trace_id: 'a/b' }).success).toBe(false);
  });

  it("calls the owner-only incident route with the connection's own token, and nothing else", async () => {
    reply({ traceId: TRACE, records: [tenantRow] });
    await call();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.test.com/v1/apps/bookkeeper/incidents/${TRACE}`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('refuses without a session and calls nothing', async () => {
    userCtx = { userId: null, token: null };
    const r = await call();
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(/Not authenticated/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("passes the backend's refusal through: a trace id of another owner's app returns the API's 403/404, never rows", async () => {
    reply('forbidden', 403);
    const r = await call({ app_id: 'someone-elses', trace_id: TRACE });
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(/API 403/);
  });

  it('explains a tenant fault: action, status, fault, safe code, SQLite class and object, when', async () => {
    reply({ traceId: TRACE, records: [tenantRow], invocation: null, truncated: false });
    const out = body(await call());
    expect(out.found).toBe(true);
    expect(out.failures).toEqual([{
      at: '2026-10-27T03:00:00.000Z', hop: 'api', level: 'warn', action: 'add_open_question', status: 500, fault: 'tenant',
      errorCode: 'internal_error', errorClass: 'SQLITE_ERROR', object: 'totl_cents',
      message: 'data worker returned 500 (tenant fault): no such column: totl_cents: SQLITE_ERROR',
    }]);
    expect(out.notes.join(' ')).toMatch(/statementIndex and trigger name are not available/);
  });

  it("counts the browser's own log rows but never echoes them: they hold whatever the app logged", async () => {
    reply({ traceId: TRACE, records: [
      { ts: 1, hop: 'browser', source: 'mediated', level: 'error', message: 'saving for alice@example.com failed', data: { email: 'alice@example.com' } },
      tenantRow,
    ] });
    const out = body(await call());
    expect(out.browserRows).toBe(1);
    expect(JSON.stringify(out)).not.toContain('alice@example.com');
    expect(out.failures).toHaveLength(1);
  });

  it('says a trace with no server row is a gap, not an all-clear', async () => {
    reply({ traceId: TRACE, records: [], invocation: null });
    const out = body(await call());
    expect(out.found).toBe(false);
    expect(out.failures).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/not proof nothing failed/);
  });

  it('keeps an app-worker invocation record, and reports truncation', async () => {
    const invocation = { id: TRACE, type: 'action', name: 'add_open_question', status: 'error', outcome: 'exception' };
    reply({ traceId: TRACE, records: [], invocation, truncated: true });
    const out = body(await call());
    expect(out.found).toBe(true);
    expect(out.invocation).toEqual(invocation);
    expect(out.truncated).toBe(true);
  });

  it('reports a non-JSON answer as an error, not as an empty trace', async () => {
    reply('<html>bad gateway</html>');
    const r = await call();
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(/non-JSON/);
  });
});

describe('SQLite error labels', () => {
  it('names the class and the object a message points at, and nothing for text it does not know', () => {
    expect(sqliteErrorClass('D1_ERROR: no such column: x: SQLITE_ERROR')).toBe('SQLITE_ERROR');
    expect(sqliteErrorClass('no such table: entries')).toBe('no such table');
    expect(sqliteErrorClass('near "SELEC": syntax error')).toBe('syntax error');
    expect(sqliteErrorClass('something unexpected')).toBeNull();
    expect(sqliteObject('no such column: totl_cents: SQLITE_ERROR')).toBe('totl_cents');
    expect(sqliteObject('UNIQUE constraint failed: entries.id: SQLITE_CONSTRAINT')).toBe('entries.id');
    expect(sqliteObject('something unexpected')).toBeNull();
  });

  it('bounds every string it returns', () => {
    const long = 'x'.repeat(2000);
    const out = summariseTrace('a', { records: [{ ts: 1, hop: 'api', message: long, data: { operation: long }, context: { operation: long, errorCode: long } }] }) as { failures: Record<string, string>[] };
    expect(out.failures[0]!.message!.length).toBe(400);
    expect(out.failures[0]!.action!.length).toBe(120);
    expect(out.failures[0]!.errorCode!.length).toBe(64);
  });
});
