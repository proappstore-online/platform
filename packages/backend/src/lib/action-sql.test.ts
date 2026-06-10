import { describe, expect, it, vi } from 'vitest';
import { prepareActionQuery, type ToolManifest } from './action-sql.js';

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
