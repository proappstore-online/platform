import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishApp } from './publish.js';

// #254: every site-manifest key in mcp.json reaches the tools registration on
// `pas publish`. Registration REPLACES site state, so a key this command
// forgot to forward would be wiped on every publish (the trap PR #271 hit for
// `visibility`). The command now forwards the whole manifest.

const MANIFEST = {
  tools: [{ name: 'upsert_repo', description: 'x', operation: 'execute', sql: 'INSERT INTO r (id) VALUES (:id)', params: {}, callers: ['worker'] }],
  page_meta: [{ path: '/r/:id', action: 'get_repo', param: 'id' }],
  sitemap: { action: 'list_repos' },
  operator: { prefix: '/admin', role: 'operator' },
  operator_view: { version: 1, resources: [], actions: [] },
  visibility: { mode: 'private', roles: ['viewer'] },
  worker: { secrets: ['GITHUB_TOKEN'] },
  hooks: [{ name: 'github', verify: { kind: 'github-hmac-sha256', secret: 'GITHUB_WEBHOOK_SECRET' }, to: 'worker' }],
};

let dir: string;
let cwd: string;
let registered: Record<string, unknown>[];

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'pas-publish-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'repos' }));
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify(MANIFEST));
  process.chdir(dir);
  registered = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/provision')) return Response.json({ appId: 'repos', steps: [], dataWorkerUrl: '', appUrl: '', success: true });
    if (url.endsWith('/v1/apps/repos/tools')) {
      registered.push(JSON.parse(String(init.body)));
      return Response.json({ registered: 1 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pas publish forwards the whole manifest (#254)', () => {
  it('registers every site key, worker included', async () => {
    await publishApp({ token: 'tok' } as never);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toEqual(MANIFEST);
  });

  it('a second publish with no changes sends the same body (nothing dropped)', async () => {
    await publishApp({ token: 'tok' } as never);
    await publishApp({ token: 'tok' } as never);
    expect(registered[1]).toEqual(registered[0]);
    expect(registered[1]!.worker).toEqual({ secrets: ['GITHUB_TOKEN'] });
  });
});

// #459: a fresh `pas create` + `pas publish` has no intervening `git push`, so
// the deploy workflow's migrate-then-register step never runs. `pas publish`
// must apply migrations.json itself, and BEFORE it registers mcp.json, or tool
// SQL is checked for schema coherence against a still-empty D1.
describe('pas publish applies migrations.json before registering tools (#459)', () => {
  const MIGRATIONS = { migrations: [{ name: '0001_init', sql: 'CREATE TABLE items (id TEXT PRIMARY KEY)' }] };
  let calls: string[];

  beforeEach(() => {
    writeFileSync(join(dir, 'migrations.json'), JSON.stringify(MIGRATIONS));
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/provision')) return Response.json({ appId: 'repos', steps: [], dataWorkerUrl: '', appUrl: '', success: true });
      if (url.endsWith('/v1/apps/repos/migrate')) {
        calls.push('migrate');
        expect(JSON.parse(String(init.body))).toEqual(MIGRATIONS);
        return Response.json({ applied: ['0001_init'], already: [] });
      }
      if (url.endsWith('/v1/apps/repos/tools')) {
        calls.push('tools');
        registered.push(JSON.parse(String(init.body)));
        return Response.json({ registered: 1 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
  });

  it('migrates before registering tools', async () => {
    await publishApp({ token: 'tok' } as never);
    expect(calls).toEqual(['migrate', 'tools']);
  });

  it('still registers tools when the migrate call fails (publish stays idempotent)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/provision')) return Response.json({ appId: 'repos', steps: [], dataWorkerUrl: '', appUrl: '', success: true });
      if (url.endsWith('/v1/apps/repos/migrate')) {
        calls.push('migrate');
        return new Response('migration failed', { status: 502 });
      }
      if (url.endsWith('/v1/apps/repos/tools')) {
        calls.push('tools');
        registered.push(JSON.parse(String(init.body)));
        return Response.json({ registered: 1 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    await publishApp({ token: 'tok' } as never);
    expect(calls).toEqual(['migrate', 'tools']);
  });
});
