import { parseStatements, type SqlToken } from './sql-statements.js';

/**
 * Tables whose names start with `_pas_` are the platform's own (#508): the entitlement mirror lives in `_pas_entitlements`, and an app
 * reads it with SELECT and JOIN but never writes it. An app that could write it could grant itself any entitlement.
 *
 * This reads statements with the same tokenizer the executor and the migration lint use, so a name inside a string or a comment is
 * not a name. It refuses a statement that WRITES: INSERT, UPDATE, DELETE, REPLACE, DROP, ALTER, CREATE (a trigger or an index
 * on one included), ATTACH or DETACH, or a WITH whose statement writes, and that mentions a `_pas_` name anywhere. A read is left alone.
 * Shared by the backend (registration, migrations) and the data worker (a non-internal caller's raw SQL).
 */

const RESERVED = /^_pas_/i;
const WRITE_HEADS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'ALTER', 'CREATE', 'ATTACH', 'DETACH']);
const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

/** The name a word or quoted-identifier token spells, without its quotes. */
function nameOf(t: SqlToken): string | null {
  if (t.kind === 'word') return t.text;
  if (t.kind === 'ident') return t.text.replace(/^["`[]/, '').replace(/["`\]]$/, '');
  return null;
}

/** The reserved name a writing statement in `sql` touches, or null when none does. */
export function writesReservedTable(sql: string): string | null {
  for (const statement of parseStatements(sql)) {
    const reserved = statement.tokens.map(nameOf).find((n): n is string => n !== null && RESERVED.test(n));
    if (!reserved) continue;
    const head = statement.tokens.find((t) => t.kind === 'word')?.upper ?? '';
    const writes = WRITE_HEADS.has(head) || (head === 'WITH' && statement.tokens.some((t) => t.kind === 'word' && DML.has(t.upper)));
    if (writes) return reserved;
  }
  return null;
}
