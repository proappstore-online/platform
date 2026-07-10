import { describe, expect, it, vi } from 'vitest';
import { prepareActionBatch, prepareActionQuery, type ToolManifest } from './action-sql.js';

const manifest: ToolManifest = {
  name: 'list_mine',
  description: 'List mine',
  operation: 'query',
  sql: 'SELECT * FROM items WHERE user_id = :__user_id AND active = :active LIMIT :limit',
  params: {
    active: { type: 'boolean', default: true },
    limit: { type: 'integer', default: 20, max: 100 },
  },
  requires_auth: true,
};

describe('prepareActionQuery', () => {
  it('injects server-owned magic params and clamps numeric input', () => {
    const query = prepareActionQuery(
      manifest,
      { __user_id: 'attacker', active: 'false', limit: 999 },
      'gh:1',
    );

    expect(query.sql).toBe('SELECT * FROM items WHERE user_id = ? AND active = ? LIMIT ?');
    expect(query.params).toEqual(['gh:1', false, 100]);
  });

  it('rejects unresolved SQL params', () => {
    expect(() => prepareActionQuery(
      {
        ...manifest,
        sql: 'SELECT * FROM items WHERE owner_id = :owner_id',
        params: {},
      },
      {},
      'gh:1',
    )).toThrow('Unresolved parameter: owner_id');
  });

  it('uses server time and UUID for magic params', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });

    const query = prepareActionQuery(
      {
        ...manifest,
        operation: 'execute',
        sql: 'INSERT INTO items (id, user_id, created_at) VALUES (:__uuid, :__user_id, :__now)',
        params: {},
      },
      { __uuid: 'attacker', __now: 1 },
      'gh:1',
    );

    expect(query.params).toEqual(['uuid-1', 'gh:1', 123]);
  });
});

describe('prepareActionBatch', () => {
  const batchManifest: ToolManifest = {
    name: 'create_thing_with_child',
    description: 'Atomic two-step create',
    operation: 'batch',
    statements: [
      'INSERT INTO things (id, owner_id, created_at) VALUES (:id, :__user_id, :__now)',
      "INSERT INTO children (thing_id, owner_id, label) VALUES (:id, :__user_id, :label)",
    ],
    params: {
      id: { type: 'string' },
      label: { type: 'string', optional: true },
    },
    requires_auth: true,
  };

  it('binds every statement against ONE shared param pool', () => {
    const prepared = prepareActionBatch(batchManifest, { id: 't1', label: 'x' }, 'gh:9');
    expect(prepared).toHaveLength(2);
    expect(prepared[0].params).toEqual(['t1', 'gh:9', expect.any(Number)]);
    expect(prepared[1].params).toEqual(['t1', 'gh:9', 'x']);
    // shared :id resolves identically across statements
    expect(prepared[0].params[0]).toBe(prepared[1].params[0]);
    expect(prepared[0].sql).not.toContain(':');
  });

  it('injects the verified caller id, ignoring a spoofed __user_id input', () => {
    const prepared = prepareActionBatch(batchManifest, { id: 't1', __user_id: 'attacker' }, 'gh:9');
    expect(prepared[0].params[1]).toBe('gh:9');
    expect(prepared[1].params[1]).toBe('gh:9');
  });

  it('rejects a batch manifest without statements', () => {
    expect(() =>
      prepareActionBatch({ ...batchManifest, statements: [] }, { id: 't1' }, 'gh:9'),
    ).toThrow(/no statements/);
  });

  it('prepareActionQuery rejects a manifest without sql', () => {
    expect(() => prepareActionQuery(batchManifest, { id: 't1' }, 'gh:9')).toThrow(/no sql/);
  });
});
