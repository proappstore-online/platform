import { describe, expect, it, vi } from 'vitest';
import type { ToolManifest } from '../action-sql.js';
import { checkSchemaCoherence, toolStatements, validateToolSet } from './tool-set.js';
import { MAX_SCHEDULED_ACTIONS_PER_APP } from './tool.js';

const scoped = { name: 'list_items', description: 'List', operation: 'query', sql: 'SELECT * FROM t WHERE user_id = :__user_id', requires_auth: true } as ToolManifest;

describe('toolStatements', () => {
  it('lists batch members, a verify tool\'s input then writes, or the single sql', () => {
    expect(toolStatements({ ...scoped, operation: 'batch', sql: undefined, statements: ['A', 'B'] })).toEqual(['A', 'B']);
    expect(toolStatements({ ...scoped, operation: 'verify', sql: 'IN', statements: ['W'] })).toEqual(['IN', 'W']);
    expect(toolStatements(scoped)).toEqual([scoped.sql]);
  });
});

describe('validateToolSet', () => {
  it('accepts a scoped set without an env (no coherence check)', async () => {
    expect(await validateToolSet([scoped], undefined, 'app')).toBeNull();
  });

  it('prefixes a manifest error with the tool name', async () => {
    const res = await validateToolSet([{ ...scoped, description: '' }], undefined, 'app');
    expect(res).toEqual({ status: 400, payload: { error: 'tool "list_items": description is required' } });
  });

  it('rejects an unscoped statement without a caller_unscoped exemption', async () => {
    const res = await validateToolSet([{ ...scoped, sql: 'SELECT * FROM t' }], undefined, 'app');
    expect(res?.status).toBe(400);
    expect(res?.payload.error).toBe('statements must include :__user_id or declare auth.caller_unscoped');
    expect(res?.payload.details).toEqual(['"list_items": statement has no :__user_id and no auth.caller_unscoped exemption']);
  });

  it('caps scheduled actions per app', async () => {
    const tools = Array.from({ length: MAX_SCHEDULED_ACTIONS_PER_APP + 1 }, (_, i) => ({ ...scoped, name: `t_${i}`, schedule: { cron: '0 * * * *', params: {} } })) as ToolManifest[];
    const res = await validateToolSet(tools, undefined, 'app');
    expect(res?.payload.error).toBe(`too many scheduled actions: received ${MAX_SCHEDULED_ACTIONS_PER_APP + 1}, max ${MAX_SCHEDULED_ACTIONS_PER_APP} per app`);
  });
});

describe('checkSchemaCoherence', () => {
  it('returns no errors for an empty tool list without calling the data worker', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      expect(await checkSchemaCoherence({} as never, 'app', [])).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
