import { describe, expect, it, vi } from 'vitest';
import { prepareActionBatch, prepareActionQuery, prepareVerifyInput, prepareVerifyWrites, referencesChildFlag, type ToolManifest } from './action-sql.js';

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

  it('rejects a negative bounded LIMIT parameter', () => {
    expect(() => prepareActionQuery(manifest, { active: true, limit: -1 }, 'gh:1'))
      .toThrow('limit must be >= 0');
  });

  it('keeps bounded numeric input in range and clamps it at the maximum', () => {
    const bounded = {
      ...manifest,
      params: { ...manifest.params, limit: { type: 'integer', max: 10 } },
    };

    expect(prepareActionQuery(bounded, { active: true, limit: 5 }, 'gh:1').params).toEqual(['gh:1', true, 5]);
    expect(prepareActionQuery(bounded, { active: true, limit: 15 }, 'gh:1').params).toEqual(['gh:1', true, 10]);
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

describe('timestamp_ms param type (#1395)', () => {
  // Fixed and well above the ms floor so this block is immune to the real
  // clock AND to an earlier test's un-restored `Date.now` spy (see the
  // 'uses server time and UUID for magic params' test above).
  const FIXED_NOW = 1_700_000_000_000;
  const occursManifest: ToolManifest = {
    name: 'record_event',
    description: 'Record event',
    operation: 'execute',
    sql: 'INSERT INTO events (occurred_at) VALUES (:occurred_at)',
    params: { occurred_at: { type: 'timestamp_ms' } },
    requires_auth: true,
  };

  it('passes through a plausible millisecond epoch value unchanged', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    try {
      const ms = FIXED_NOW - 1000;
      expect(prepareActionQuery(occursManifest, { occurred_at: ms }, 'gh:1').params).toEqual([ms]);
    } finally { now.mockRestore(); }
  });

  it('normalises a 10-digit UNIX-seconds value by multiplying it into milliseconds', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    try {
      const seconds = Math.floor((FIXED_NOW - 1000) / 1000);
      expect(prepareActionQuery(occursManifest, { occurred_at: seconds }, 'gh:1').params).toEqual([seconds * 1000]);
    } finally { now.mockRestore(); }
  });

  it('rejects a non-integer value', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    try {
      expect(() => prepareActionQuery(occursManifest, { occurred_at: FIXED_NOW + 0.5 }, 'gh:1'))
        .toThrow('occurred_at must be an integer millisecond epoch timestamp');
    } finally { now.mockRestore(); }
  });

  it('rejects a value too small to be a plausible timestamp even after seconds normalisation', () => {
    expect(() => prepareActionQuery(occursManifest, { occurred_at: 5 }, 'gh:1'))
      .toThrow('occurred_at must be a plausible millisecond epoch timestamp');
  });

  it('rejects a value far enough in the future to not be clock skew', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    try {
      const farFuture = FIXED_NOW + 24 * 60 * 60 * 1000;
      expect(() => prepareActionQuery(occursManifest, { occurred_at: farFuture }, 'gh:1'))
        .toThrow('occurred_at must be a plausible millisecond epoch timestamp');
    } finally { now.mockRestore(); }
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

  it('reads the clock once per batch, so :__now is identical across statements and occurrences', () => {
    const manifest: ToolManifest = {
      ...batchManifest,
      statements: [
        'UPDATE things SET updated_at = :__now WHERE id = :id AND owner_id = :__user_id',
        'INSERT INTO audit (thing_id, at, seen_at) SELECT :id, :__now, :__now FROM things WHERE id = :id AND updated_at = :__now',
      ],
    };
    const clock = vi.spyOn(Date, 'now');
    let t = 1_000;
    clock.mockImplementation(() => t++); // every read ticks — the binder must read once
    try {
      const prepared = prepareActionBatch(manifest, { id: 't1' }, 'gh:9');
      const nows = [prepared[0].params[0], ...prepared[1].params.filter((v, i) => i !== 0 && i !== 3 && typeof v === 'number')];
      expect(new Set(nows).size).toBe(1);
      expect(nows).toHaveLength(4);
    } finally {
      clock.mockRestore();
    }
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

describe('verify tools (#148)', () => {
  const verifyManifest: ToolManifest = {
    name: 'claim_game_over',
    description: 'Verify a game is over by replaying its moves',
    operation: 'verify',
    verifier: 'chess.replay',
    sql: 'SELECT moves FROM games WHERE id = :game_id AND (white_id = :__user_id OR black_id = :__user_id)',
    statements: [
      "UPDATE games SET status = 'finished', result = :__verify_result, end_reason = :__verify_reason, finished_at = :__now WHERE id = :game_id AND status = 'active' AND :__verify_over = 1",
      "INSERT INTO game_events (id, game_id, kind, at) VALUES (:__uuid, :game_id, 'verified', :__now)",
    ],
    params: { game_id: { type: 'string' } },
    requires_auth: true,
  };

  it('prepareVerifyInput binds the scoped SELECT with the caller id, never the client one', () => {
    const q = prepareVerifyInput(verifyManifest, { game_id: 'g1', __user_id: 'attacker' }, 'gh:1');
    expect(q).toEqual({ sql: 'SELECT moves FROM games WHERE id = ? AND (white_id = ? OR black_id = ?)', params: ['g1', 'gh:1', 'gh:1'] });
  });

  it('prepareVerifyWrites binds :__verify_<output> from the verdict, shares :__now, and keeps :__uuid per occurrence', () => {
    const writes = prepareVerifyWrites(verifyManifest, { game_id: 'g1' }, 'gh:1', { over: true, result: '0-1', reason: 'checkmate' });
    expect(writes).toHaveLength(2);
    expect(writes[0]!.sql).toBe("UPDATE games SET status = 'finished', result = ?, end_reason = ?, finished_at = ? WHERE id = ? AND status = 'active' AND ? = 1");
    expect(writes[0]!.params).toEqual(['0-1', 'checkmate', expect.any(Number), 'g1', true]);
    expect(typeof writes[1]!.params[0]).toBe('string'); // :__uuid (the file stubs randomUUID)
    expect(writes[1]!.params[2]).toBe(writes[0]!.params[2]); // one clock reading for the whole write set
  });

  it('prepareVerifyWrites is empty for a read-only verify tool, and an unknown output is unresolved', () => {
    expect(prepareVerifyWrites({ ...verifyManifest, statements: undefined }, { game_id: 'g1' }, 'gh:1', { over: true })).toEqual([]);
    expect(() => prepareVerifyWrites(verifyManifest, { game_id: 'g1' }, 'gh:1', { over: true })).toThrow('Unresolved parameter: __verify_result');
    expect(() => prepareVerifyInput({ ...verifyManifest, sql: undefined }, { game_id: 'g1' }, 'gh:1')).toThrow('has no sql');
  });
});

// #513: the caller's child flag sits next to :__user_id as a server-owned value, 1 or 0, never read from the request.
describe(':__user_is_child (#513)', () => {
  const guarded: ToolManifest = {
    name: 'register_family', description: 'Register a family', operation: 'execute', requires_auth: true,
    sql: 'INSERT INTO families (id, owner) SELECT :id, :__user_id WHERE :__user_is_child = 0',
    params: { id: { type: 'string' } },
  };

  it('binds 1 for a child and 0 for anyone else, and defaults to 0', () => {
    expect(prepareActionQuery(guarded, { id: 'f1' }, 'cred:kid', true).params).toEqual(['f1', 'cred:kid', 1]);
    expect(prepareActionQuery(guarded, { id: 'f1' }, 'cred:adult', false).params).toEqual(['f1', 'cred:adult', 0]);
    expect(prepareActionQuery(guarded, { id: 'f1' }, 'gh:1').params).toEqual(['f1', 'gh:1', 0]);
  });

  it('ignores a client-supplied __user_is_child, undeclared or declared as a param', () => {
    expect(prepareActionQuery(guarded, { id: 'f1', __user_is_child: 0 }, 'cred:kid', true).params[2]).toBe(1);
    const declared: ToolManifest = { ...guarded, params: { id: { type: 'string' }, __user_is_child: { type: 'integer', default: 0 } } };
    expect(prepareActionQuery(declared, { id: 'f1', __user_is_child: 0 }, 'cred:kid', true).params[2]).toBe(1);
  });

  it('is the same value in every statement of a batch and in a verify tool\'s input and writes', () => {
    const batch: ToolManifest = { name: 'b', description: 'b', operation: 'batch', requires_auth: true, params: {},
      statements: ['UPDATE a SET x = 1 WHERE u = :__user_id AND :__user_is_child = 1', 'UPDATE b SET y = 1 WHERE u = :__user_id AND :__user_is_child = 1'] };
    expect(prepareActionBatch(batch, {}, 'cred:kid', true).map((q) => q.params)).toEqual([['cred:kid', 1], ['cred:kid', 1]]);
    expect(prepareActionBatch(batch, {}, 'cred:adult').map((q) => q.params)).toEqual([['cred:adult', 0], ['cred:adult', 0]]);

    const verify: ToolManifest = { name: 'v', description: 'v', operation: 'verify', verifier: 'chess', requires_auth: true, params: {},
      sql: 'SELECT moves FROM games WHERE owner = :__user_id AND :__user_is_child = 0', statements: ['UPDATE games SET done = 1 WHERE owner = :__user_id AND :__user_is_child = 0'] };
    expect(prepareVerifyInput(verify, {}, 'cred:kid', true).params).toEqual(['cred:kid', 1]);
    expect(prepareVerifyWrites(verify, {}, 'cred:kid', {}, true)[0]!.params).toEqual(['cred:kid', 1]);
  });

  it('referencesChildFlag sees it in sql or in any statement, and only as a whole name', () => {
    expect(referencesChildFlag(guarded)).toBe(true);
    expect(referencesChildFlag({ ...guarded, sql: undefined, statements: ['SELECT 1', 'SELECT :__user_is_child'] })).toBe(true);
    expect(referencesChildFlag({ ...guarded, sql: 'SELECT :__user_id' })).toBe(false);
    expect(referencesChildFlag({ ...guarded, sql: 'SELECT :__user_is_children' })).toBe(false);
  });
});
