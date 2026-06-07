import { describe, expect, it } from 'vitest';
import { prepareQuery, type ToolManifest } from './sql-engine.js';

function manifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name: 'test_tool',
    description: 'test',
    operation: 'query',
    sql: 'SELECT * FROM items',
    params: {},
    ...overrides,
  };
}

describe('prepareQuery', () => {
  // ── Named → positional conversion ──────────────────────────

  it('converts named params to positional', () => {
    const m = manifest({
      sql: 'SELECT * FROM items WHERE category = :category LIMIT :limit',
      params: {
        category: { type: 'string' },
        limit: { type: 'integer', default: 20 },
      },
    });
    const result = prepareQuery(m, { category: 'eng' }, null);
    expect(result.sql).toBe('SELECT * FROM items WHERE category = ? LIMIT ?');
    expect(result.params).toEqual(['eng', 20]);
  });

  it('handles same param referenced multiple times', () => {
    const m = manifest({
      sql: 'SELECT * FROM t WHERE a = :x OR b = :x',
      params: { x: { type: 'string' } },
    });
    const result = prepareQuery(m, { x: 'val' }, null);
    expect(result.sql).toBe('SELECT * FROM t WHERE a = ? OR b = ?');
    expect(result.params).toEqual(['val', 'val']);
  });

  it('handles SQL with no params', () => {
    const m = manifest({ sql: 'SELECT * FROM items' });
    const result = prepareQuery(m, {}, null);
    expect(result.sql).toBe('SELECT * FROM items');
    expect(result.params).toEqual([]);
  });

  // ── Defaults and optionals ─────────────────────────────────

  it('applies default value when param is missing', () => {
    const m = manifest({
      sql: 'SELECT * FROM t LIMIT :limit',
      params: { limit: { type: 'integer', default: 20 } },
    });
    const result = prepareQuery(m, {}, null);
    expect(result.params).toEqual([20]);
  });

  it('uses provided value over default', () => {
    const m = manifest({
      sql: 'SELECT * FROM t LIMIT :limit',
      params: { limit: { type: 'integer', default: 20 } },
    });
    const result = prepareQuery(m, { limit: 5 }, null);
    expect(result.params).toEqual([5]);
  });

  it('resolves optional param as null when missing', () => {
    const m = manifest({
      sql: 'SELECT * FROM t WHERE (:cat IS NULL OR category = :cat)',
      params: { cat: { type: 'string', optional: true } },
    });
    const result = prepareQuery(m, {}, null);
    expect(result.params).toEqual([null, null]);
  });

  // ── Type coercion ──────────────────────────────────────────

  it('coerces string to integer', () => {
    const m = manifest({
      sql: 'LIMIT :n',
      params: { n: { type: 'integer' } },
    });
    const result = prepareQuery(m, { n: '10' }, null);
    expect(result.params).toEqual([10]);
  });

  it('throws on non-integer for integer type', () => {
    const m = manifest({
      sql: 'LIMIT :n',
      params: { n: { type: 'integer' } },
    });
    expect(() => prepareQuery(m, { n: 'abc' }, null)).toThrow('n must be an integer');
  });

  it('throws on float for integer type', () => {
    const m = manifest({
      sql: 'LIMIT :n',
      params: { n: { type: 'integer' } },
    });
    expect(() => prepareQuery(m, { n: 3.5 }, null)).toThrow('n must be an integer');
  });

  it('clamps integer to max', () => {
    const m = manifest({
      sql: 'LIMIT :n',
      params: { n: { type: 'integer', max: 100 } },
    });
    const result = prepareQuery(m, { n: 500 }, null);
    expect(result.params).toEqual([100]);
  });

  it('coerces number type', () => {
    const m = manifest({
      sql: 'WHERE price > :min',
      params: { min: { type: 'number' } },
    });
    const result = prepareQuery(m, { min: '3.14' }, null);
    expect(result.params).toEqual([3.14]);
  });

  it('throws on NaN for number type', () => {
    const m = manifest({
      sql: 'WHERE price > :min',
      params: { min: { type: 'number' } },
    });
    expect(() => prepareQuery(m, { min: 'nope' }, null)).toThrow('min must be a number');
  });

  it('coerces boolean correctly (avoids Boolean("false") === true)', () => {
    const m = manifest({
      sql: 'WHERE active = :active',
      params: { active: { type: 'boolean' } },
    });
    expect(prepareQuery(m, { active: true }, null).params).toEqual([true]);
    expect(prepareQuery(m, { active: false }, null).params).toEqual([false]);
    expect(prepareQuery(m, { active: 'true' }, null).params).toEqual([true]);
    expect(prepareQuery(m, { active: 'false' }, null).params).toEqual([false]);
    expect(prepareQuery(m, { active: '0' }, null).params).toEqual([false]);
    expect(prepareQuery(m, { active: '' }, null).params).toEqual([false]);
    expect(prepareQuery(m, { active: 'no' }, null).params).toEqual([false]);
    expect(prepareQuery(m, { active: 'yes' }, null).params).toEqual([true]);
    expect(prepareQuery(m, { active: 1 }, null).params).toEqual([true]);
    expect(prepareQuery(m, { active: 0 }, null).params).toEqual([false]);
  });

  it('coerces to string', () => {
    const m = manifest({
      sql: 'WHERE id = :id',
      params: { id: { type: 'string' } },
    });
    const result = prepareQuery(m, { id: 123 }, null);
    expect(result.params).toEqual(['123']);
  });

  // ── Magic params ───────────────────────────────────────────

  it('injects __user_id when authenticated', () => {
    const m = manifest({
      sql: 'SELECT * FROM t WHERE user_id = :__user_id',
    });
    const result = prepareQuery(m, {}, 'gh:42');
    expect(result.params).toEqual(['gh:42']);
  });

  it('throws on __user_id when not authenticated', () => {
    const m = manifest({
      sql: 'SELECT * FROM t WHERE user_id = :__user_id',
    });
    expect(() => prepareQuery(m, {}, null)).toThrow('requires authentication');
  });

  it('injects __now as epoch ms number', () => {
    const m = manifest({
      sql: 'INSERT INTO t (ts) VALUES (:__now)',
    });
    const before = Date.now();
    const result = prepareQuery(m, {}, null);
    const after = Date.now();
    expect(typeof result.params[0]).toBe('number');
    expect(result.params[0] as number).toBeGreaterThanOrEqual(before);
    expect(result.params[0] as number).toBeLessThanOrEqual(after);
  });

  it('injects __uuid as valid UUID', () => {
    const m = manifest({
      sql: 'INSERT INTO t (id) VALUES (:__uuid)',
    });
    const result = prepareQuery(m, {}, null);
    expect(result.params[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('generates unique __uuid per call', () => {
    const m = manifest({
      sql: 'INSERT INTO t (id, ref) VALUES (:__uuid, :__uuid)',
    });
    const result = prepareQuery(m, {}, null);
    // Each reference to __uuid calls the factory again, so they differ
    expect(result.params[0]).not.toBe(result.params[1]);
  });

  // ── Validation errors ──────────────────────────────────────

  it('throws on missing required param', () => {
    const m = manifest({
      sql: 'WHERE id = :id',
      params: { id: { type: 'string' } },
    });
    expect(() => prepareQuery(m, {}, null)).toThrow('Missing required parameter: id');
  });

  it('skips null coercion for optional null values', () => {
    const m = manifest({
      sql: 'WHERE (:x IS NULL)',
      params: { x: { type: 'integer', optional: true } },
    });
    const result = prepareQuery(m, {}, null);
    expect(result.params).toEqual([null]);
  });

  // ── Missing params field ───────────────────────────────────

  it('handles manifest with undefined params', () => {
    const m = manifest({
      sql: 'SELECT * FROM t WHERE id = :__uuid',
      params: undefined as unknown as Record<string, never>,
    });
    const result = prepareQuery(m, {}, null);
    expect(result.sql).toBe('SELECT * FROM t WHERE id = ?');
    expect(result.params[0]).toMatch(/^[0-9a-f-]+$/);
  });

  it('handles manifest with no declared params and only magic params', () => {
    const m = manifest({
      sql: 'INSERT INTO t (id, user_id) VALUES (:__uuid, :__user_id)',
      params: {},
    });
    const result = prepareQuery(m, {}, 'gh:1');
    expect(result.params).toHaveLength(2);
    expect(result.params[1]).toBe('gh:1');
  });

  // ── Extra input params are ignored ─────────────────────────

  it('throws on unresolved parameter not in manifest', () => {
    const m = manifest({
      sql: 'SELECT * FROM t WHERE x = :undeclared',
      params: {},
    });
    expect(() => prepareQuery(m, {}, null)).toThrow(/[Uu]nresolved.*undeclared/);
  });

  it('ignores extra input params not in manifest', () => {
    const m = manifest({
      sql: 'SELECT * FROM t LIMIT :limit',
      params: { limit: { type: 'integer', default: 10 } },
    });
    const result = prepareQuery(m, { limit: 5, extra: 'ignored', foo: 42 }, null);
    expect(result.params).toEqual([5]);
  });
});
