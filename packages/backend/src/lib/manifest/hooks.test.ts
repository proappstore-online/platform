import { describe, expect, it } from 'vitest';
import type { ToolManifest } from '../action-sql.js';
import { validateHooks } from './hooks.js';

const verify = { kind: 'github-app' };
const action = {
  name: 'record_event', description: 'Record', operation: 'execute', requires_auth: true,
  sql: 'INSERT INTO events (kind) VALUES (:kind)', params: { kind: { type: 'string' } },
  callers: ['hook'], auth: { caller_unscoped: { reason: 'webhook' } },
} as unknown as ToolManifest;

describe('validateHooks', () => {
  it('treats an absent section as no hooks', () => {
    expect(validateHooks(undefined, [])).toEqual({ hooks: [] });
    expect(validateHooks(null, [])).toEqual({ hooks: [] });
  });

  it('accepts a hook to the worker', () => {
    const res = validateHooks([{ name: 'gh', verify, to: 'worker' }], []);
    expect(res).toMatchObject({ hooks: [{ name: 'gh', to: 'worker' }] });
  });

  it('accepts a hook to a hook action, mapping params by path or literal', () => {
    const res = validateHooks([{ name: 'gh', verify, to: { action: 'record_event', params: { kind: '$.action' } } }], [action]);
    expect(res).toMatchObject({ hooks: [{ name: 'gh', to: { action: 'record_event', params: { kind: '$.action' } } }] });
  });

  it('refuses a non-array, too many hooks, unknown fields, bad and repeated names', () => {
    expect(validateHooks({}, [])).toEqual({ error: 'hooks must be an array of at most 10 hooks' });
    expect(validateHooks(Array.from({ length: 11 }, () => ({})), [])).toEqual({ error: 'hooks must be an array of at most 10 hooks' });
    expect(validateHooks([{ name: 'a', verify, to: 'worker', x: 1 }], [])).toEqual({ error: 'hooks[0]: unknown field "x"' });
    expect(validateHooks([{ name: 'A', verify, to: 'worker' }], [])).toMatchObject({ error: expect.stringContaining('hooks[0].name must match') });
    expect(validateHooks([{ name: 'a', verify, to: 'worker' }, { name: 'a', verify, to: 'worker' }], [])).toEqual({ error: 'hooks[1]: duplicate name "a"' });
  });

  it('refuses an action that is not a hook action', () => {
    const to = { action: 'record_event' };
    expect(validateHooks([{ name: 'a', verify, to }], [])).toEqual({ error: 'hooks[0].to.action must name an action in this manifest' });
    expect(validateHooks([{ name: 'a', verify, to }], [{ ...action, callers: ['user'] } as ToolManifest]))
      .toEqual({ error: 'hooks[0].to.action "record_event" must list "hook" in its callers' });
    expect(validateHooks([{ name: 'a', verify, to }], [{ ...action, operation: 'query' } as ToolManifest]))
      .toEqual({ error: 'hooks[0].to.action "record_event" must be an execute or batch action' });
    expect(validateHooks([{ name: 'a', verify, to }], [{ ...action, auth: { caller_unscoped: { reason: 'r' }, app_roles: ['x'] } } as ToolManifest]))
      .toEqual({ error: 'hooks[0].to.action "record_event" cannot be role-gated (system:hook holds no role)' });
  });

  it('refuses params that are undeclared, malformed paths or objects', () => {
    const run = (params: Record<string, unknown>) => validateHooks([{ name: 'a', verify, to: { action: 'record_event', params } }], [action]);
    expect(run({ nope: 1 })).toEqual({ error: 'hooks[0].to.params: "nope" is not a param of "record_event"' });
    expect(run({ kind: '$.a b' })).toEqual({ error: 'hooks[0].to.params.kind: "$.a b" is not a path like $.a.b or $.a[0]' });
    expect(run({ kind: { a: 1 } })).toEqual({ error: 'hooks[0].to.params.kind must be a path or a literal' });
  });

  it('refuses a target that is neither "worker" nor { action, params }', () => {
    expect(validateHooks([{ name: 'a', verify, to: 'elsewhere' }], [])).toEqual({ error: 'hooks[0].to must be "worker" or { action, params }' });
  });
});
