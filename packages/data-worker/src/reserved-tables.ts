import { parseStatements, type SqlToken } from './sql-statements.js';

/**
 * Tables whose names start with `_pas_` are the platform's own (#508): the entitlement mirror lives in `_pas_entitlements`, and an app
 * reads it with SELECT and JOIN but never writes it. An app that could write it could grant itself any entitlement.
 *
 * This reads statements with the same tokenizer the executor and the migration lint use, so a name inside a string or a comment is
 * not a name. Shared by the backend (registration, migrations) and the data worker (a non-internal caller's raw SQL).
 *
 * #511: a `_pas_` name is only refused when it is the statement's WRITE TARGET — the table after `INSERT [OR …] INTO`,
 * `REPLACE INTO`, `UPDATE [OR …]` or `DELETE FROM` (a `WITH` prefix is skipped to find it, and a CTE name is never the target,
 * since the target lookup starts only after the CTE list ends). A `_pas_` name read inside a subquery, JOIN, WHERE, ON CONFLICT
 * or RETURNING — including the paywall pattern `… WHERE NOT EXISTS (SELECT … FROM _pas_entitlements …)` — is a read and is left
 * alone. CREATE, ALTER, DROP, ATTACH and DETACH keep the conservative rule: refused when a `_pas_` name appears anywhere, so a
 * trigger body, index or view that touches one is still caught.
 *
 * #512: this guard is what stops an app granting itself entitlements, so a DML statement whose target `writeTarget()` cannot
 * determine fails closed — refused when it mentions any `_pas_` name, exactly as DDL is — rather than passing through as an
 * unrecognised shape would otherwise let it.
 */

const RESERVED = /^_pas_/i;
const DDL_HEADS = new Set(['DROP', 'ALTER', 'CREATE', 'ATTACH', 'DETACH']);
const DML_HEADS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
const DML_OR_SELECT = new Set([...DML_HEADS, 'SELECT']);

/** The name a word or quoted-identifier token spells, without its quotes. */
function nameOf(t: SqlToken | undefined): string | null {
  if (!t) return null;
  if (t.kind === 'word') return t.text;
  if (t.kind === 'ident') return t.text.replace(/^["`[]/, '').replace(/["`\]]$/, '');
  return null;
}

/** Is `t` the bare word `w`? */
function isWord(t: SqlToken | undefined, w: string): boolean {
  return t !== undefined && t.kind === 'word' && t.upper === w;
}

/** Index of the first token at paren depth 0 (relative to `from`) matching `pred`, or -1. */
function atDepth0(tokens: SqlToken[], from: number, pred: (t: SqlToken) => boolean): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'punct' && t.text === '(') depth++;
    else if (t.kind === 'punct' && t.text === ')') depth--;
    else if (depth === 0 && pred(t)) return i;
  }
  return -1;
}

/** The (possibly schema-qualified, possibly quoted) table name starting at `from`: the right-most `name` of a `name(.name)*` run. */
function targetTable(tokens: SqlToken[], from: number): string | null {
  let i = from;
  let last: string | null = null;
  for (;;) {
    const n = nameOf(tokens[i]);
    if (n === null) return last;
    last = n;
    i++;
    if (tokens[i] && tokens[i]!.kind === 'punct' && tokens[i]!.text === '.') {
      i++;
      continue;
    }
    return last;
  }
}

/** The table a DML statement writes, given the index of its INSERT/UPDATE/DELETE/REPLACE keyword. */
function writeTarget(tokens: SqlToken[], headIdx: number, head: string): string | null {
  let i = headIdx + 1;
  if (head === 'INSERT') {
    if (isWord(tokens[i], 'OR')) i += 2;
    return isWord(tokens[i], 'INTO') ? targetTable(tokens, i + 1) : null;
  }
  if (head === 'REPLACE') {
    return isWord(tokens[i], 'INTO') ? targetTable(tokens, i + 1) : null;
  }
  if (head === 'UPDATE') {
    if (isWord(tokens[i], 'OR')) i += 2;
    return targetTable(tokens, i);
  }
  if (head === 'DELETE') {
    return isWord(tokens[i], 'FROM') ? targetTable(tokens, i + 1) : null;
  }
  return null;
}

/** The reserved name a writing statement in `sql` touches, or null when none does. */
export function writesReservedTable(sql: string): string | null {
  for (const statement of parseStatements(sql)) {
    const tokens = statement.tokens;
    const headIdx = tokens.findIndex((t) => t.kind === 'word');
    if (headIdx === -1) continue;
    const head = tokens[headIdx]!.upper;

    if (DDL_HEADS.has(head)) {
      const reserved = tokens.map(nameOf).find((n): n is string => n !== null && RESERVED.test(n));
      if (reserved) return reserved;
      continue;
    }

    let dmlHead = head;
    let dmlIdx = headIdx;
    if (head === 'WITH') {
      const j = atDepth0(tokens, headIdx + 1, (t) => t.kind === 'word' && DML_OR_SELECT.has(t.upper));
      if (j < 0) continue;
      dmlHead = tokens[j]!.upper;
      dmlIdx = j;
    }
    if (!DML_HEADS.has(dmlHead)) continue;

    const target = writeTarget(tokens, dmlIdx, dmlHead);
    if (target === null) {
      // #512: an unrecognised shape must not become a bypass — fail closed exactly as DDL does.
      const reserved = tokens.map(nameOf).find((n): n is string => n !== null && RESERVED.test(n));
      if (reserved) return reserved;
      continue;
    }
    if (RESERVED.test(target)) return target;
  }
  return null;
}
