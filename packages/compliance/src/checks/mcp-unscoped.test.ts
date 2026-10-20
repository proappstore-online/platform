import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkMcpUnscoped } from './mcp-unscoped.js';

const unscoped = { caller_unscoped: { reason: 'shared' } };
const listTags = { name: 'list_tags', operation: 'query', sql: 'SELECT id, label FROM tags', requires_auth: true, auth: unscoped };
const approval = { action: 'list_tags', reviewer: 'serge-ivo', date: '2026-10-20', reason: 'shared tag list' };
const run = (manifest?: unknown) => checkMcpUnscoped(mapFileSource(new Map(manifest === undefined ? [] : [['mcp.json', typeof manifest === 'string' ? manifest : JSON.stringify(manifest)]])));

describe('checkMcpUnscoped (#426)', () => {
  it('passes with no mcp.json, no unscoped actions, or all approved', async () => {
    expect((await run()).status).toBe('pass');
    expect((await run({ tools: [{ ...listTags, auth: {} }] })).status).toBe('pass');
    expect(await run({ tools: [listTags], approved_unscoped: [approval] })).toMatchObject({ status: 'pass', detail: expect.stringMatching(/1 unscoped action/) });
  });

  it('warns on an unapproved unscoped action and on unapproved personal data', async () => {
    expect(await run({ tools: [listTags] })).toMatchObject({ status: 'warn', detail: expect.stringMatching(/"list_tags" .*no approved_unscoped entry/) });
    expect(await run({ tools: [{ ...listTags, sql: 'SELECT id, email FROM users' }] })).toMatchObject({ status: 'warn', detail: expect.stringMatching(/\[SECURITY\]/) });
  });

  it('fails on a malformed approval list and on approved personal data or *', async () => {
    expect((await run({ tools: [listTags], approved_unscoped: [{ ...approval, reviewer: '' }] })).status).toBe('fail');
    expect((await run({ tools: [{ ...listTags, sql: 'SELECT id, email FROM users' }], approved_unscoped: [approval] })).status).toBe('fail');
    expect((await run({ tools: [{ ...listTags, sql: 'SELECT * FROM tags' }], approved_unscoped: [approval] })).status).toBe('fail');
  });

  it('ignores scheduled, worker-only and role-gated actions', async () => {
    const tools = [
      { ...listTags, name: 'a', schedule: { cron: '0 * * * *' } },
      { ...listTags, name: 'b', callers: ['worker'] },
      { ...listTags, name: 'c', auth: { ...unscoped, app_roles: ['admin'] } },
    ];
    expect((await run({ tools })).status).toBe('pass');
  });

  it('leaves unparseable JSON to registration', async () => {
    expect((await run('{ nope')).status).toBe('pass');
  });
});
