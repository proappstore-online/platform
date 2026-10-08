import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #261: the owner CLI for app workers — `pas worker|hook|schedule` — and
// `pas secret set` reading the value from a hidden prompt or stdin, not argv.

vi.mock('./lib/config.js', () => ({
  readConfig: async () => ({ apiBase: 'https://api.test', session: { token: 'tok' } }),
}));

const { readSecretValue } = await import('./secret.js');
const { parseSince, workerLogLines, workerCommand } = await import('./worker.js');
const { hookCommand } = await import('./hook.js');
const { scheduleCommand } = await import('./schedule.js');

let out: string[];
let err: string[];
let calls: { method: string; url: string; headers: Headers; body: string | undefined }[];
let routes: Record<string, unknown>;

beforeEach(() => {
  out = [];
  err = [];
  calls = [];
  routes = {};
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true; });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({ method, url, headers, body: init.body === undefined ? undefined : String(init.body) });
    expect(headers.get('Authorization')).toBe('Bearer tok');
    const path = new URL(url).pathname;
    const body = routes[`${method} ${path}`];
    if (body instanceof Response) return body;
    return body === undefined ? Response.json({ error: 'not found' }, { status: 404 }) : Response.json(body, { status: method === 'POST' ? 202 : 200 });
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function tty(): PassThrough & { isTTY: boolean; setRawMode: ReturnType<typeof vi.fn> } {
  return Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
}

describe('pas secret set input (#261)', () => {
  it('prompts on a TTY with raw mode (no echo) and returns what was typed, honouring backspace', async () => {
    const input = tty();
    const value = readSecretValue('FOO', undefined, {}, input as never);
    input.write('s3crx\u007ft\r');
    expect(await value).toBe('s3crt');
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(err.join('')).not.toContain('s3cr');
    expect(err.join('')).toContain('input hidden');
  });

  it('reads --stdin to the end, dropping one trailing newline', async () => {
    const input = new PassThrough();
    const value = readSecretValue('FOO', undefined, { stdin: true }, input as never);
    input.end('v-from-pipe\n');
    expect(await value).toBe('v-from-pipe');
  });

  it('still takes a positional value, with a deprecation warning on stderr', async () => {
    expect(await readSecretValue('FOO', 'legacy', {}, new PassThrough() as never)).toBe('legacy');
    expect(err.join('')).toMatch(/deprecated/);
  });

  it('refuses a non-TTY without --stdin, and an empty value', async () => {
    await expect(readSecretValue('FOO', undefined, {}, new PassThrough() as never)).rejects.toThrow('exit 1');
    expect(err.join('')).toMatch(/--stdin/);
    const input = new PassThrough();
    const value = readSecretValue('FOO', undefined, { stdin: true }, input as never);
    input.end('\n');
    await expect(value).rejects.toThrow('exit 1');
  });
});

describe('pas worker logs (#261)', () => {
  it('parses --since windows', () => {
    expect(parseSince('30s')).toBe(30_000);
    expect(parseSince('10m')).toBe(600_000);
    expect(parseSince('1h')).toBe(3_600_000);
    expect(parseSince('2d')).toBe(172_800_000);
    expect(() => parseSince('1w')).toThrow(/--since/);
  });

  it('merges PAS.log lines and finished invocations after since, oldest first', async () => {
    routes['GET /v1/apps/demo/logs'] = { logs: [{ ts: 3000, level: 'info', message: 'synced', data: { count: 2 } }] };
    routes['GET /v1/apps/demo/worker'] = {
      worker: { enabled: 1 }, last_deploy: null, schedules: [],
      invocations: [
        { id: 'a', type: 'schedule', name: 'sync', attempt: 1, status: 'failed', http_status: 500, started_at: 1000, finished_at: 2000, error: 'upstream 502' },
        { id: 'b', type: 'hook', name: 'github', attempt: 1, status: 'running', http_status: null, started_at: 4000, finished_at: null, error: null },
        { id: 'c', type: 'http', name: null, attempt: 1, status: 'succeeded', http_status: 200, started_at: 10, finished_at: 20, error: null },
      ],
    };
    const lines = await workerLogLines({ apiBase: 'https://api.test', session: { token: 'tok' } } as never, 'demo', 1000);
    expect(lines.map((l) => l.line)).toEqual([
      `${new Date(2000).toISOString()}  run    schedule sync attempt 1 failed (500): upstream 502`,
      `${new Date(3000).toISOString()}  info   synced {"count":2}`,
    ]);
    expect(calls[0]!.url).toBe('https://api.test/v1/apps/demo/logs?category=worker&since=1000&limit=500');
  });
});

describe('owner commands (#261)', () => {
  const run = (cmd: typeof workerCommand, args: string[]) => cmd.parseAsync(['node', cmd.name(), ...args, '--app', 'demo']);

  it('enables and disables a worker through the admin endpoint', async () => {
    routes['PUT /v1/admin/apps/demo/worker-enabled'] = { ok: true, enabled: true };
    await workerCommand.parseAsync(['node', 'worker', 'enable', 'demo']);
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      url: 'https://api.test/v1/admin/apps/demo/worker-enabled',
      body: JSON.stringify({ enabled: true }),
    });
    expect(calls.at(-1)!.headers.get('Authorization')).toBe('Bearer tok');
    expect(out.join('')).toContain('✓ Worker enabled for demo');

    routes['PUT /v1/admin/apps/demo/worker-enabled'] = { ok: true, enabled: false };
    await workerCommand.parseAsync(['node', 'worker', 'disable', 'demo']);
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      url: 'https://api.test/v1/admin/apps/demo/worker-enabled',
      body: JSON.stringify({ enabled: false }),
    });
    expect(calls.at(-1)!.headers.get('Authorization')).toBe('Bearer tok');
    expect(out.join('')).toContain('✓ Worker disabled for demo');
  });

  it.each([
    [403, 'app workers are limited to first-party apps during the prototype'],
    [409, 'app worker cap reached (5)'],
    [409, 'app workers are closed to new apps (account ceiling)'],
    [404, 'app not found'],
  ])('prints the server error and exits for an enable failure (%i)', async (status, error) => {
    routes['PUT /v1/admin/apps/demo/worker-enabled'] = Response.json({ error }, { status });
    await expect(workerCommand.parseAsync(['node', 'worker', 'enable', 'demo'])).rejects.toThrow('exit 1');
    expect(err.join('')).toContain(`enable worker failed (${status}): ${error}`);
  });

  it('pas schedule run <name> queues a run; pas schedule runs labels worker runs and in-progress ones', async () => {
    routes['POST /v1/apps/demo/worker/schedules/reconcile/run'] = { run_id: 'r1', status: 'due' };
    await run(scheduleCommand, ['run', 'reconcile']);
    expect(out.join('')).toContain('queued reconcile (run r1)');
    routes['GET /v1/apps/demo/scheduled-runs'] = { runs: [
      { run_id: 'r1', action_name: 'worker:reconcile', due_at: 0, finished_at: null, status: 'due', changes: null, error: null },
      { run_id: 'r0', action_name: 'digest', due_at: 0, finished_at: 1, status: 'failed', changes: null, error: 'boom' },
    ] };
    await run(scheduleCommand, ['runs', '--status', 'failed']);
    expect(calls.at(-1)!.url).toBe('https://api.test/v1/apps/demo/scheduled-runs?limit=50&status=failed');
    expect(out.join('')).toMatch(/worker reconcile\s+in progress \(due\)/);
    expect(out.join('')).toMatch(/action digest\s+failed\n {2}boom/);
  });

  it('pas hook deliveries <name> --status failed filters on the server; hook list flags a missing secret', async () => {
    routes['GET /v1/apps/demo/hook-deliveries'] = { deliveries: [
      { id: 'd', hook: 'github', delivery_id: 'gh-1', event: 'push', received_at: 0, status: 'failed', attempts: 2, finished_at: 1, error: 'worker answered 500' },
    ] };
    await run(hookCommand, ['deliveries', 'github', '--status', 'failed']);
    expect(calls.at(-1)!.url).toBe('https://api.test/v1/apps/demo/hook-deliveries?hook=github&limit=50&status=failed');
    expect(out.join('')).toContain('worker answered 500');
    routes['GET /v1/apps/demo/hooks'] = { hooks: [
      { name: 'github', url: 'https://api.test/v1/apps/demo/hooks/github', verify_kind: 'github-hmac-sha256', secret_name: 'GH_SECRET', secret_set: false, to: 'worker' },
    ] };
    await run(hookCommand, ['list']);
    expect(out.join('')).toContain('GH_SECRET MISSING');
    await expect(run(hookCommand, ['deliveries', 'github', '--status', 'nope'])).rejects.toThrow('exit 1');
  });

  it('pas worker status shows a breaker-disabled schedule; rotate posts; a server error exits with its message', async () => {
    routes['GET /v1/apps/demo/worker'] = {
      worker: { enabled: 1, backend: 'loader', deployed_sha: 'abcdef1234567890', deployed_ref: 'refs/heads/main', deployed_at: 0 },
      last_deploy: { sha: 'abcdef1234567890', ref: 'refs/heads/main', status: 'deployed', detail: 'redeploy', created_at: 0 },
      invocations: [],
      schedules: [{ name: 'reconcile', cron: '*/15 * * * *', consecutive_failures: 5, schedule_disabled_at: 1 }],
    };
    routes['GET /v1/apps/demo/worker/usage'] = {
      quotas: { invocations: 5000, cpu_ms: 3600000, hook_deliveries: 2000 }, cpu_ms_source: 'wall',
      today: { day: '2026-10-06', invocations: 12, cpu_ms: 3400, hook_deliveries: 2, pas_calls: 40 },
    };
    await run(workerCommand, ['status']);
    expect(out.join('')).toMatch(/reconcile\s+\*\/15 \* \* \* \*\s+DISABLED after 5 failures/);
    expect(out.join('')).toContain('invocations 12/5000 · wall-clock ms 3400/3600000 · hook deliveries 2/2000 · PAS calls 40');
    routes['POST /v1/apps/demo/worker/rotate'] = { ok: true, config_version: 3 };
    await run(workerCommand, ['rotate']);
    expect(out.join('')).toContain('config version 3');
    await expect(run(scheduleCommand, ['run', 'nope'])).rejects.toThrow('exit 1');
    expect(err.join('')).toContain('run nope failed (404): not found');
  });
});
