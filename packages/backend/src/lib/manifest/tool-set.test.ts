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

describe('reserved _pas_ tables (#508)', () => {
  const action = (over: Partial<ToolManifest>) => ({ ...scoped, ...over }) as ToolManifest;

  it('lets an action read and JOIN the entitlement table', async () => {
    const read = action({ name: 'can_view', sql: 'SELECT 1 FROM _pas_entitlements e JOIN kids k ON k.id = e.subject WHERE k.user_id = :__user_id AND e.status = \'active\'' });
    expect(await validateToolSet([read], undefined, 'app')).toBeNull();
  });

  it('refuses an action that writes one, naming the tool, the statement and the table', async () => {
    const write = action({ name: 'grant_myself', operation: 'execute', sql: "INSERT INTO _pas_entitlements (product, subject, status) VALUES ('t', :__user_id, 'active')" });
    expect(await validateToolSet([write], undefined, 'app')).toEqual({
      status: 400,
      payload: { error: 'tool "grant_myself": statement 1 writes _pas_entitlements; _pas_* tables are platform-owned and read-only for apps' },
    });
  });

  it('finds a write in the second statement of a batch', async () => {
    const batch = action({ name: 'sneaky', operation: 'batch', sql: undefined, statements: ['INSERT INTO notes (u) VALUES (:__user_id)', 'UPDATE _pas_entitlements SET status = \'active\' WHERE :__user_id IS NOT NULL'] });
    const res = await validateToolSet([batch], undefined, 'app');
    expect(res?.payload.error).toBe('tool "sneaky": statement 2 writes _pas_entitlements; _pas_* tables are platform-owned and read-only for apps');
  });
});

