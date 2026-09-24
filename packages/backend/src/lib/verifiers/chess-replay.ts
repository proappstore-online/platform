/**
 * `chess.replay` — replay a stored move list with chess.js and report the
 * position (#148, chess-academy#128).
 *
 * Input rows (from the action's scoped SELECT), either shape:
 *   · ONE row with a `moves` column: a JSON array of SAN or UCI strings, or a
 *     whitespace-separated string of them;
 *   · N rows, one move each, in the SELECT's ORDER BY, in a `move` (or `san`,
 *     or `uci`) column — the per-move log shape.
 * An optional `fen` column on the first row sets the starting position.
 *
 * Moves are replayed strictly: the first illegal move stops the replay, and
 * `legal` is false with its index. `over`, `result` and `reason` describe the
 * position after the last replayed move and are only meaningful when `legal`
 * is true (an illegal list is never "over").
 */

import { Chess } from 'chess.js';
import type { Verifier, VerifierOutcome, VerifierScalar } from './index.js';

/** Longest move list accepted (plies). Real games top out well under this. */
export const MAX_PLIES = 1000;

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i;
const MOVE_COLUMNS = ['move', 'san', 'uci'] as const;

export const chessReplay: Verifier = {
  id: 'chess.replay',
  description:
    'Replays a stored chess move list (SAN or UCI) from the start position, or from an optional FEN, ' +
    'and reports legality, whether the game is over, the result and the reason.',
  input:
    'One row with a `moves` column (JSON array or whitespace-separated SAN/UCI), or one row per move ' +
    'in a `move` / `san` / `uci` column ordered by ply. Optional `fen` column on the first row.',
  outputs: {
    legal: { type: 'boolean', description: 'Every move was legal from the position it was played in.' },
    illegal_index: { type: 'integer', description: '0-based index of the first illegal move, or null.' },
    illegal_move: { type: 'string', description: 'The first illegal move as supplied, or null.' },
    ply: { type: 'integer', description: 'Number of moves replayed.' },
    over: { type: 'boolean', description: 'The position after the last move ends the game.' },
    result: { type: 'string', description: '"1-0", "0-1", "1/2-1/2", or null while the game is in progress.' },
    reason: {
      type: 'string',
      description: '"checkmate", "stalemate", "insufficient_material", "threefold_repetition", "fifty_moves", or null.',
    },
    turn: { type: 'string', description: 'Side to move after the last replayed move: "w" or "b".' },
    in_check: { type: 'boolean', description: 'The side to move is in check.' },
    fen: { type: 'string', description: 'FEN of the position after the last replayed move.' },
  },

  run(rows): VerifierOutcome {
    const parsed = extractMoves(rows);
    if ('error' in parsed) return { ok: false, error: parsed.error, output: {} };
    const { moves, fen } = parsed;

    let chess: Chess;
    try {
      chess = fen ? new Chess(fen) : new Chess();
    } catch (e) {
      return { ok: false, error: `invalid fen: ${e instanceof Error ? e.message : String(e)}`, output: {} };
    }

    let illegalIndex: number | null = null;
    let illegalMove: string | null = null;
    for (let i = 0; i < moves.length; i++) {
      const raw = moves[i]!;
      try {
        const uci = UCI_RE.exec(raw);
        chess.move(
          uci
            ? { from: uci[1]!.toLowerCase(), to: uci[2]!.toLowerCase(), ...(uci[3] ? { promotion: uci[3].toLowerCase() } : {}) }
            : raw,
          { strict: false },
        );
      } catch {
        illegalIndex = i;
        illegalMove = raw;
        break;
      }
    }

    const legal = illegalIndex === null;
    const over = legal && chess.isGameOver();
    let reason: string | null = null;
    let result: string | null = null;
    if (over) {
      if (chess.isCheckmate()) {
        reason = 'checkmate';
        result = chess.turn() === 'w' ? '0-1' : '1-0';
      } else {
        result = '1/2-1/2';
        reason = chess.isStalemate()
          ? 'stalemate'
          : chess.isInsufficientMaterial()
            ? 'insufficient_material'
            : chess.isThreefoldRepetition()
              ? 'threefold_repetition'
              : 'fifty_moves';
      }
    }

    const output: Record<string, VerifierScalar> = {
      legal,
      illegal_index: illegalIndex,
      illegal_move: illegalMove,
      ply: chess.history().length,
      over,
      result,
      reason,
      turn: chess.turn(),
      in_check: chess.inCheck(),
      fen: chess.fen(),
    };
    return { ok: true, output };
  },
};

function extractMoves(rows: Record<string, unknown>[]): { moves: string[]; fen: string | null } | { error: string } {
  if (rows.length === 0) return { error: 'no input row' };
  const first = rows[0]!;
  const fen = typeof first.fen === 'string' && first.fen.trim() ? first.fen.trim() : null;

  let moves: string[];
  if (rows.length === 1 && 'moves' in first) {
    const raw = first.moves;
    if (raw === null || raw === undefined || raw === '') moves = [];
    else if (typeof raw !== 'string') return { error: 'moves must be a string' };
    else {
      const text = raw.trim();
      if (text.startsWith('[')) {
        let list: unknown;
        try { list = JSON.parse(text); } catch { return { error: 'moves is not a JSON array' }; }
        if (!Array.isArray(list) || !list.every((m) => typeof m === 'string')) return { error: 'moves must be a JSON array of strings' };
        moves = list as string[];
      } else {
        moves = text.split(/\s+/).filter(Boolean);
      }
    }
  } else {
    const column = MOVE_COLUMNS.find((c) => c in first);
    if (!column) return { error: 'expected a `moves` column on one row, or a `move` column per row' };
    moves = [];
    for (const row of rows) {
      const m = row[column];
      if (typeof m !== 'string' || !m.trim()) return { error: `row ${moves.length}: ${column} must be a non-empty string` };
      moves.push(m.trim());
    }
  }
  if (moves.length > MAX_PLIES) return { error: `move list has ${moves.length} plies, max ${MAX_PLIES}` };
  return { moves: moves.map((m) => m.trim()), fen };
}
