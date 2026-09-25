import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { ProjectDO } from './project-do.ts';
import { providerForRole, RUNTIME_KEY_PROVIDERS } from './byo-key.ts';
import { rowToRoleConfig } from './store.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

function fakeState() {
  const db = new DatabaseSync(':memory:');
  const broadcasts: Record<string, unknown>[] = [];
  const socket = { send: (data: string) => { broadcasts.push(JSON.parse(data) as Record<string, unknown>); } };
  const state = {
    storage: {
      sql: {
        exec(sql: string, ...params: unknown[]) {
          if (/^\s*select/i.test(sql)) return { toArray: () => db.prepare(sql).all(...(params as never[])) };
          if (params.length === 0) db.exec(sql); else db.prepare(sql).run(...(params as never[]));
          return { toArray: () => [] };
        },
      },
    },
    getWebSockets: () => [socket],
  };
  return { state, broadcasts, db };
}

const OWNER = 'gh:owner';
const H = { 'X-User-Id': OWNER, 'Content-Type': 'application/json' };

afterEach(() => vi.unstubAllGlobals());

/** #3: the provider mapping lives on the role config; no key → graceful fallbacks. */
describe('BYO key provider mapping on role configs (#3)', () => {
  async function project(env: Record<string, unknown>) {
    const { state, broadcasts, db } = fakeState();
    const doInstance = new ProjectDO(state as never, env as never);
    expect((await doInstance.fetch(new Request('http://do/project', { method: 'PUT', headers: H, body: JSON.stringify({ name: 'Keys', slug: 'keys', ownerId: OWNER }) }))).status).toBe(200);
    return { doInstance, broadcasts, db };
  }

  it('GET /roles reports each role\'s keyProvider, defaulting to the runtime\'s native provider', async () => {
    const { doInstance } = await project({});
    const { roles } = (await (await doInstance.fetch(new Request('http://do/roles', { headers: H }))).json()) as { roles: { role: string; runtime: string; keyProvider: string }[] };
    expect(roles.map((r) => [r.role, r.runtime, r.keyProvider])).toEqual([
      ['Architect', 'cf-native', 'anthropic'], ['BA', 'cf-native', 'anthropic'], ['Dev', 'cf-native', 'anthropic'], ['QA', 'cf-native', 'anthropic'],
    ]);
  });

  it('PUT /roles persists a compatible keyProvider and refuses an incompatible one without writing anything', async () => {
    const { doInstance, db } = await project({});
    const dev = { role: 'Dev', runtime: 'openai-responses', model: 'gpt-5', spineTools: ['read_file'], vendorTools: [] };
    const ok = await doInstance.fetch(new Request('http://do/roles', { method: 'PUT', headers: H, body: JSON.stringify({ roles: [{ ...dev, keyProvider: 'openai' }] }) }));
    expect(ok.status).toBe(200);
    expect(db.prepare("SELECT key_provider FROM role_configs WHERE role = 'Dev'").get()).toEqual({ key_provider: 'openai' });

    const bad = await doInstance.fetch(new Request('http://do/roles', { method: 'PUT', headers: H, body: JSON.stringify({ roles: [{ ...dev, model: 'gpt-6', keyProvider: 'anthropic' }] }) }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'key provider "anthropic" cannot be used by runtime "openai-responses" (accepts: openai)' });
    expect(db.prepare("SELECT model FROM role_configs WHERE role = 'Dev'").get()).toEqual({ model: 'gpt-5' }); // the batch was refused whole
  });

  it('providerForRole / rowToRoleConfig: stored mapping wins, else the runtime\'s native provider', () => {
    expect(providerForRole({ runtime: 'cf-native' })).toBe('anthropic');
    expect(providerForRole({ runtime: 'openai-responses' })).toBe('openai');
    expect(providerForRole({ runtime: 'openai-responses', keyProvider: 'openai' })).toBe('openai');
    expect(rowToRoleConfig({ role: 'Dev', runtime: 'cf-native', model: 'm', key_provider: null }).keyProvider).toBe('anthropic');
    expect(rowToRoleConfig({ role: 'Dev', runtime: 'openai-responses', model: 'm', key_provider: 'openai' }).keyProvider).toBe('openai');
    expect(RUNTIME_KEY_PROVIDERS).toEqual({ 'cf-native': ['anthropic'], 'openai-responses': ['openai'] });
  });

  it('with no key in the vault the PO chat still answers (rule-based triage) and never calls the model', async () => {
    const vault = vi.fn(async (_req: Request) => Response.json({ key: null }));
    const model = vi.fn();
    vi.stubGlobal('fetch', model);
    const { doInstance, broadcasts } = await project({ PAS_BACKEND: { fetch: vault }, INTERNAL_TOKEN: 'internal-secret' });
    const res = await doInstance.fetch(new Request('http://do/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: 'Build me a todo app with sharing' }) }));
    expect(res.status).toBe(200);
    const reply = (await res.json()) as { role: string; body: string };
    expect(reply.role).toBe('po');
    expect(reply.body.length).toBeGreaterThan(10);
    expect(vault).toHaveBeenCalledOnce();
    expect(new URL(vault.mock.calls[0]![0].url).pathname).toBe('/v1/keys/resolve/anthropic');
    expect(model).not.toHaveBeenCalled();
    expect(broadcasts.some((b) => b.type === 'chat' && b.role === 'po')).toBe(true);
  });
});
