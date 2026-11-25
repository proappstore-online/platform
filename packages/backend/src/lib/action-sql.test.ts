import { describe, expect, it, vi } from 'vitest';
import { actionD1LimitError } from '@proappstore/compliance';
import { batchPayload, prepareActionBatch, prepareActionQuery, prepareVerifyInput, prepareVerifyWrites, referencesChildFlag, unknownParamsError, type ToolManifest } from './action-sql.js';

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
  it('injects server-owned magic params, and binds each name to one numbered slot (#575)', () => {
    const query = prepareActionQuery(
      manifest,
      { __user_id: 'attacker', active: 'false', limit: 50 },
      'gh:1',
    );

    expect(query.sql).toBe('SELECT * FROM items WHERE user_id = ?1 AND active = ?2 LIMIT ?3');
    expect(query.params).toEqual(['gh:1', false, 50]);
  });

  it('binds a param repeated many times once, so it counts once against D1\'s 100 (#575)', () => {
    const repeated: ToolManifest = {
      ...manifest,
      sql: `SELECT * FROM quotes WHERE ${Array.from({ length: 82 }, () => 'lat = :pickup_lat').join(' OR ')} AND owner = :__user_id`,
      params: { pickup_lat: { type: 'number' } },
    };
    const query = prepareActionQuery(repeated, { pickup_lat: -33.9 }, 'gh:1');
    expect(query.params).toEqual([-33.9, 'gh:1']);
    expect(query.sql.match(/\?1\b/g)).toHaveLength(82);
    expect(query.sql).toMatch(/AND owner = \?2$/);
  });

  it('rejects a negative bounded LIMIT parameter', () => {
    expect(() => prepareActionQuery(manifest, { active: true, limit: -1 }, 'gh:1'))
      .toThrow('limit must be >= 0');
  });

  it('refuses a value over the maximum, naming the param and its limit, instead of clamping it (#600)', () => {
    const bounded = {
      ...manifest,
      params: { ...manifest.params, limit: { type: 'integer', max: 10 }, ratio: { type: 'number', max: 1.5 } },
    } as ToolManifest;

    expect(prepareActionQuery(bounded, { active: true, limit: 10, ratio: 1.5 }, 'gh:1').params).toEqual(['gh:1', true, 10]);
    expect(() => prepareActionQuery(bounded, { active: true, limit: 11, ratio: 1 }, 'gh:1')).toThrow('limit must be <= 10');
    expect(() => prepareActionQuery(bounded, { active: true, limit: 1, ratio: 1.6 }, 'gh:1')).toThrow('ratio must be <= 1.5');
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

  it(':__call_uuid is one value across every statement and occurrence of a call, while :__uuid stays per occurrence (#562)', () => {
    let n = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++n}` });
    const manifest: ToolManifest = {
      ...batchManifest,
      statements: [
        'INSERT INTO things (id, owner_id, ref) VALUES (:__call_uuid, :__user_id, :__uuid)',
        'INSERT INTO notes (thing_id, id, again) VALUES (:__call_uuid, :__uuid, :__call_uuid)',
      ],
      params: {},
    };
    const [a, b] = prepareActionBatch(manifest, { __call_uuid: 'attacker' }, 'gh:9');
    const call = a!.params[0];
    expect(call).not.toBe('attacker');
    expect(a!.sql).toBe('INSERT INTO things (id, owner_id, ref) VALUES (?1, ?2, ?3)');
    // #575: a repeated name reuses its slot; :__uuid takes a fresh one at each occurrence.
    expect(b!.sql).toBe('INSERT INTO notes (thing_id, id, again) VALUES (?1, ?2, ?1)');
    expect([a!.params[0], b!.params[0]]).toEqual([call, call]);
    expect(new Set([a!.params[2], b!.params[1], call]).size).toBe(3);
    // a different call gets a different id
    expect(prepareActionBatch(manifest, {}, 'gh:9')[0]!.params[0]).not.toBe(call);
    // a single-statement action binds it too
    const q = prepareActionQuery({ ...manifest, operation: 'execute', sql: 'SELECT :__call_uuid, :__call_uuid, :__uuid, :__uuid', statements: undefined }, {}, 'gh:9');
    expect(q.sql).toBe('SELECT ?1, ?1, ?2, ?3');
    expect(q.params).toHaveLength(3);
    expect(q.params[1]).not.toBe(q.params[2]);
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
      // Every :__now occurrence in the second statement is its one slot ?2.
      expect(prepared[1].sql).toBe('INSERT INTO audit (thing_id, at, seen_at) SELECT ?1, ?2, ?2 FROM things WHERE id = ?1 AND updated_at = ?2');
      expect(prepared[0].params[0]).toBe(prepared[1].params[1]);
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
    expect(q).toEqual({ sql: 'SELECT moves FROM games WHERE id = ?1 AND (white_id = ?2 OR black_id = ?2)', params: ['g1', 'gh:1'] });
  });

  it('prepareVerifyWrites binds :__verify_<output> from the verdict, shares :__now, and keeps :__uuid per occurrence', () => {
    const writes = prepareVerifyWrites(verifyManifest, { game_id: 'g1' }, 'gh:1', { over: true, result: '0-1', reason: 'checkmate' });
    expect(writes).toHaveLength(2);
    expect(writes[0]!.sql).toBe("UPDATE games SET status = 'finished', result = ?1, end_reason = ?2, finished_at = ?3 WHERE id = ?4 AND status = 'active' AND ?5 = 1");
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

describe('batchPayload (#565)', () => {
  const statements = [{ sql: 'INSERT INTO b VALUES (1)', params: [] }];
  const manifest = { name: 'm', description: 'd', operation: 'batch', params: {}, requires_auth: true } as ToolManifest;

  it('carries the budget designation only when the manifest declares one', () => {
    expect(batchPayload(manifest, statements)).toEqual({ statements });
    expect(batchPayload({ ...manifest, budget_statement_index: 0 }, statements)).toEqual({ statements, budget_statement_index: 0 });
  });
});

describe('D1 parameter count parity (#571, #575)', () => {
  // The registration lint (`@proappstore/compliance` lib/d1-limits.ts) counts bound parameters with its own copy of the
  // executor's pattern. This pins the two together: the lint's 100 is exactly the number of values the executor binds:
  // one per distinct name, one per :__uuid occurrence, and an occurrence in a string or comment is bound too.
  const tricky = (n: number) => {
    const fixed = ":a, :a, :__user_id, :__now, ':a in a string' /* :a */, :__uuid, :__uuid";
    const slots = 5; // :a, :__user_id, :__now, and :__uuid twice
    return `SELECT ${fixed}, ${Array.from({ length: n - slots }, (_, i) => `:p${i}`).join(', ')} FROM t`;
  };
  const tool = (n: number): ToolManifest => ({
    name: 'q', description: 'q', operation: 'query', sql: tricky(n), requires_auth: true,
    params: Object.fromEntries([['a', { type: 'string' }], ...Array.from({ length: n }, (_, i) => [`p${i}`, { type: 'string', default: 'v' }])]),
  });

  it('binds exactly as many values as the lint counts, at the boundary', () => {
    expect(prepareActionQuery(tool(100), { a: 'x' }, 'u1').params).toHaveLength(100);
    expect(actionD1LimitError(tool(100))).toBeNull();
    expect(prepareActionQuery(tool(101), { a: 'x' }, 'u1').params).toHaveLength(101);
    expect(actionD1LimitError(tool(101))).toMatch(/binds 101 parameters/);
  });
});

// #600: an agent sent `email` to an action that takes `invitee_email`; the key was dropped and the
// invite was created without an email. A key the action does not declare is now named and refused.
describe('unknownParamsError (#600)', () => {
  const invite: ToolManifest = {
    name: 'create_candidate_invite', description: 'Invite', operation: 'execute', requires_auth: true,
    sql: 'INSERT INTO invites (email, by) VALUES (:invitee_email, :__user_id)',
    params: { invitee_email: { type: 'string' }, note: { type: 'string', optional: true } },
  };

  it('names each undeclared key and what the action takes', () => {
    expect(unknownParamsError(invite, { email: 'a@b.c' })).toBe('Unknown parameter: email. This action takes: invitee_email, note');
    expect(unknownParamsError(invite, { email: 'a@b.c', name: 'x', note: 'n' })).toBe('Unknown parameters: email, name. This action takes: invitee_email, note');
    expect(unknownParamsError({ params: {} }, { x: 1 })).toBe('Unknown parameter: x. This action takes no parameters');
  });

  it('accepts declared keys, an empty input, and the magic names the platform resolves itself', () => {
    expect(unknownParamsError(invite, { invitee_email: 'a@b.c', note: null })).toBeNull();
    expect(unknownParamsError(invite, {})).toBeNull();
    expect(unknownParamsError({ params: undefined } as unknown as ToolManifest, {})).toBeNull();
    expect(unknownParamsError(invite, { invitee_email: 'a@b.c', __user_id: 'attacker', __now: 1 })).toBeNull();
    // An inherited property name is not a declared param.
    expect(unknownParamsError(invite, { toString: 'x' })).toMatch(/^Unknown parameter: toString/);
  });
});
