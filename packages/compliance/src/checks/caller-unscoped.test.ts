import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkCallerUnscoped } from './caller-unscoped.js';

const tool = (name: string, reason?: string) => ({
  name,
  operation: 'query',
  sql: 'SELECT id FROM things',
  requires_auth: true,
  ...(reason === undefined ? {} : { auth: { caller_unscoped: { reason } } }),
});
const run = (manifest?: unknown) => checkCallerUnscoped(mapFileSource(new Map(manifest === undefined ? [] : [['mcp.json', typeof manifest === 'string' ? manifest : JSON.stringify(manifest)]])));

describe('checkCallerUnscoped (#518)', () => {
  it('passes with no mcp.json or no caller_unscoped action', async () => {
    expect((await run()).status).toBe('pass');
    expect((await run({ tools: [tool('list_things')] })).status).toBe('pass');
  });

  it('warns on a caller_unscoped action with a specific reason', async () => {
    const result = await run({ tools: [tool('get_platform_config', 'App-wide setting every signed-in user reads; holds no user data.')] });
    expect(result).toMatchObject({ status: 'warn', detail: expect.stringMatching(/"get_platform_config": "App-wide setting/) });
    expect(result.detail).not.toMatch(/VAGUE REASON/);
  });

  it('warns more loudly on an empty or generic reason', async () => {
    for (const reason of ['', 'legacy', 'port', 'todo', '  TODO.  ']) {
      const result = await run({ tools: [tool('stale_action', reason)] });
      expect(result, reason).toMatchObject({ status: 'warn', detail: expect.stringMatching(/VAGUE REASON/) });
      expect(result.suggestions?.join(' '), reason).toMatch(/empty or generic/);
    }
  });

  it('is not role-gated: reports a caller_unscoped action even with app_roles', async () => {
    const gated = { ...tool('admin_export', 'operator-only aggregate'), auth: { caller_unscoped: { reason: 'operator-only aggregate' }, app_roles: ['operator'] } };
    expect((await run({ tools: [gated] })).status).toBe('warn');
  });

  it('lists every caller_unscoped action, named, in one result', async () => {
    const tools = [tool('a', 'reason a'), tool('b', ''), tool('b_no_cu'), tool('c', 'todo')];
    const result = await run({ tools });
    expect(result.detail).toMatch(/3 caller_unscoped action/);
    expect(result.detail).toMatch(/"a": "reason a"/);
    expect(result.detail).toMatch(/"c" \[VAGUE REASON\]/);
  });

  it('leaves unparseable JSON to registration', async () => {
    expect((await run('{ nope')).status).toBe('pass');
  });
});
