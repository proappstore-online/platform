/**
 * Platform-vetted verifiers — the trusted, non-SQL execution path for
 * registered actions (#148).
 *
 * A `verify` action (routes/actions.ts) runs its `sql` (a scoped SELECT) on the
 * app's data worker, hands the rows to ONE of these modules in this Worker,
 * and — only when the verifier completes — binds the verdict as
 * `:__verify_<output>` into the action's optional write `statements`, which run
 * atomically on the data worker. The app never supplies code: it names a
 * verifier id, and the code that runs is this platform-owned, reviewed module.
 *
 * Contract for every verifier:
 *   · pure and deterministic — no I/O, no clock, no randomness; the same rows
 *     always give the same verdict, so a stored result can be re-derived later;
 *   · bounded — a hard row cap here plus the module's own size cap, so a hostile
 *     input cannot burn CPU;
 *   · flat output — scalars only, every declared key always present (null when
 *     not applicable), so the SQL binder can bind them positionally.
 */

import { chessReplay } from './chess-replay.js';

export type VerifierScalar = string | number | boolean | null;

export interface VerifierOutputSpec {
  type: 'string' | 'integer' | 'boolean';
  description: string;
}

export interface VerifierOutcome {
  /** True when the verifier ran to completion on well-formed input. The verdict
   *  itself (legal, over, …) is in `output`; `ok: false` means "could not verify"
   *  (no rows, missing column, malformed data) and no write statements run. */
  ok: boolean;
  error?: string;
  output: Record<string, VerifierScalar>;
}

export interface Verifier {
  id: string;
  description: string;
  /** The row contract the action's `sql` must satisfy — published in docs and the tools listing. */
  input: string;
  outputs: Record<string, VerifierOutputSpec>;
  run(rows: Record<string, unknown>[]): VerifierOutcome;
}

/** Input rows above this count are refused before the verifier runs. */
export const MAX_VERIFY_ROWS = 5000;

export const VERIFIERS: Readonly<Record<string, Verifier>> = Object.freeze({
  [chessReplay.id]: chessReplay,
});

export function getVerifier(id: unknown): Verifier | null {
  return typeof id === 'string' && Object.hasOwn(VERIFIERS, id) ? VERIFIERS[id]! : null;
}

/** Run a verifier defensively: row cap, throws → `ok: false`, every declared output present. */
export function runVerifier(verifier: Verifier, rows: unknown): VerifierOutcome {
  const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  if (list.length > MAX_VERIFY_ROWS) {
    return { ok: false, error: `verifier input has ${list.length} rows, max ${MAX_VERIFY_ROWS}`, output: emptyOutput(verifier) };
  }
  let outcome: VerifierOutcome;
  try {
    outcome = verifier.run(list);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), output: emptyOutput(verifier) };
  }
  return { ...outcome, output: { ...emptyOutput(verifier), ...outcome.output } };
}

function emptyOutput(verifier: Verifier): Record<string, VerifierScalar> {
  return Object.fromEntries(Object.keys(verifier.outputs).map((k) => [k, null]));
}
