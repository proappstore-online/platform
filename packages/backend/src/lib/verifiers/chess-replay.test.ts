import { describe, expect, it } from 'vitest';
import { chessReplay, MAX_PLIES } from './chess-replay.js';
import { getVerifier, MAX_VERIFY_ROWS, runVerifier, VERIFIERS } from './index.js';

const FOOLS_MATE = ['f3', 'e5', 'g4', 'Qh4#'];

describe('chess.replay verifier (#148)', () => {
  it('replays a SAN list in a JSON `moves` column to checkmate: over, result and reason are derived server-side', () => {
    const r = chessReplay.run([{ moves: JSON.stringify(FOOLS_MATE) }]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({ legal: true, illegal_index: null, ply: 4, over: true, result: '0-1', reason: 'checkmate', turn: 'w', in_check: true });
    expect(r.output.fen).toBe('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  });

  it('accepts whitespace-separated UCI, and one-row-per-move input in a `move` column', () => {
    const uci = chessReplay.run([{ moves: 'f2f3 e7e5 g2g4 d8h4' }]);
    expect(uci.output).toMatchObject({ legal: true, over: true, reason: 'checkmate', result: '0-1' });
    const perRow = chessReplay.run(FOOLS_MATE.map((move) => ({ move })));
    expect(perRow.output).toMatchObject({ legal: true, over: true, reason: 'checkmate' });
    expect(chessReplay.run([{ san: 'e4' }, { san: 'e5' }]).output).toMatchObject({ legal: true, over: false, result: null, reason: null, ply: 2, turn: 'w' });
  });

  it('reports the first illegal move by index and never calls an illegal list "over"', () => {
    const r = chessReplay.run([{ moves: '["e4","e5","Ke2","Ke7","Qh5#"]' }]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({ legal: false, illegal_index: 4, illegal_move: 'Qh5#', ply: 4, over: false, result: null, reason: null });
  });

  it('detects stalemate and a draw by insufficient material, and honours a starting FEN', () => {
    // Black to move, stalemated.
    const stale = chessReplay.run([{ fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', moves: '' }]);
    expect(stale.output).toMatchObject({ legal: true, ply: 0, over: true, result: '1/2-1/2', reason: 'stalemate' });
    // White captures the last piece: bare kings.
    const bare = chessReplay.run([{ fen: '7k/8/8/8/8/8/6q1/7K w - - 0 1', moves: 'Kxg2' }]);
    expect(bare.output).toMatchObject({ legal: true, over: true, result: '1/2-1/2', reason: 'insufficient_material' });
    // Checkmate delivered by White → 1-0.
    const white = chessReplay.run([{ moves: 'e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#' }]);
    expect(white.output).toMatchObject({ over: true, result: '1-0', reason: 'checkmate', turn: 'b' });
  });

  it('cannot verify without rows, without a moves column, with a bad JSON array, or with a bad FEN', () => {
    expect(chessReplay.run([])).toMatchObject({ ok: false, error: 'no input row' });
    expect(chessReplay.run([{ id: 'g1' }])).toMatchObject({ ok: false, error: expect.stringContaining('expected a `moves` column') });
    expect(chessReplay.run([{ moves: '[1,2]' }])).toMatchObject({ ok: false, error: 'moves must be a JSON array of strings' });
    expect(chessReplay.run([{ moves: '[' }])).toMatchObject({ ok: false, error: 'moves is not a JSON array' });
    expect(chessReplay.run([{ moves: 42 }])).toMatchObject({ ok: false, error: 'moves must be a string' });
    expect(chessReplay.run([{ fen: 'not a fen', moves: 'e4' }])).toMatchObject({ ok: false, error: expect.stringContaining('invalid fen') });
    expect(chessReplay.run([{ move: 'e4' }, { move: '' }])).toMatchObject({ ok: false, error: 'row 1: move must be a non-empty string' });
    const tooLong = chessReplay.run([{ moves: JSON.stringify(Array(MAX_PLIES + 1).fill('e4')) }]);
    expect(tooLong).toMatchObject({ ok: false, error: `move list has ${MAX_PLIES + 1} plies, max ${MAX_PLIES}` });
  });
});

describe('verifier registry', () => {
  it('resolves only known ids', () => {
    expect(getVerifier('chess.replay')).toBe(VERIFIERS['chess.replay']);
    expect(getVerifier('toString')).toBeNull();
    expect(getVerifier(undefined)).toBeNull();
    expect(getVerifier('app.code')).toBeNull();
  });

  it('runVerifier fills every declared output, caps rows, and turns a throw into ok:false', () => {
    const partial = runVerifier(chessReplay, [{ moves: 'e4' }]);
    expect(Object.keys(partial.output).sort()).toEqual(Object.keys(chessReplay.outputs).sort());
    const failed = runVerifier(chessReplay, []);
    expect(failed.ok).toBe(false);
    expect(failed.output).toEqual(Object.fromEntries(Object.keys(chessReplay.outputs).map((k) => [k, null])));
    const capped = runVerifier(chessReplay, Array(MAX_VERIFY_ROWS + 1).fill({ move: 'e4' }));
    expect(capped).toMatchObject({ ok: false, error: `verifier input has ${MAX_VERIFY_ROWS + 1} rows, max ${MAX_VERIFY_ROWS}` });
    const thrown = runVerifier({ ...chessReplay, run: () => { throw new Error('boom'); } }, [{ moves: 'e4' }]);
    expect(thrown).toMatchObject({ ok: false, error: 'boom' });
    expect(runVerifier(chessReplay, 'not-rows')).toMatchObject({ ok: false, error: 'no input row' });
  });
});
