// ── Allowed SQL prefixes and safety rules ──────────────────────────
const ALLOWED_PREFIXES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const FORBIDDEN_KEYWORDS = ['CREATE', 'DROP', 'ALTER', 'PRAGMA', 'ATTACH', 'DETACH', 'VACUUM', 'REINDEX'];

/** Strip line and block comments, so a comment cannot hide a paren or a keyword from the scan. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ');
}

/**
 * The verb of the statement a leading CTE prefixes (#120).
 *
 * `WITH [RECURSIVE] name [(cols)] AS [NOT MATERIALIZED] ( … ) [, …] <verb> …`
 * is one statement in SQLite, and a recursive CTE in front of an INSERT or
 * UPDATE is the natural way to do server-side validation in a SQL-only action
 * surface. Skip the CTE list by tracking parenthesis depth — ignoring parens
 * inside single-quoted strings — and return the first token after it. Without
 * a WITH prefix the verb is simply the first token. Returns null when no verb
 * can be found (unterminated CTE, empty statement).
 */
export function mainStatementVerb(sql: string): string | null {
  const text = stripComments(sql).trim();
  const upper = text.toUpperCase();
  if (!/^WITH\b/.test(upper)) return /^[A-Z]+/.exec(upper)?.[0] ?? null;

  let i = /^WITH\s+RECURSIVE\b/.test(upper) ? 'WITH RECURSIVE'.length : 'WITH'.length;
  for (;;) {
    // Advance to this CTE's body: the first "(" that follows its AS keyword.
    const as = /\bAS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/g;
    as.lastIndex = i;
    const m = as.exec(upper);
    if (!m) return null;
    let depth = 0;
    let j = m.index + m[0].length - 1; // at the "("
    for (; j < text.length; j++) {
      const ch = text[j];
      if (ch === "'") {
        // Skip a string literal ('' is an escaped quote).
        j++;
        while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    if (depth !== 0) return null;
    i = j + 1;
    const rest = upper.slice(i).trimStart();
    if (rest.startsWith(',')) { i += upper.slice(i).indexOf(',') + 1; continue; }
    return /^[A-Z]+/.exec(rest)?.[0] ?? null;
  }
}

export function validateSql(sql: string, operation: string): string | null {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  // The statement — after any leading WITH clause (#120) — must be one of the
  // allowed verbs. `WITH` itself is not a verb: a CTE only prefixes one.
  const verb = mainStatementVerb(trimmed);
  if (!verb || !ALLOWED_PREFIXES.includes(verb)) {
    return `SQL must start with ${ALLOWED_PREFIXES.join(', ')} (optionally preceded by a WITH / WITH RECURSIVE clause)`;
  }
  const isSelectLike = verb === 'SELECT';

  // No semicolons (prevent multi-statement)
  if (trimmed.includes(';')) {
    return 'SQL must not contain semicolons (no multi-statement)';
  }

  // No DDL keywords
  for (const kw of FORBIDDEN_KEYWORDS) {
    // Match as whole word
    if (new RegExp(`\\b${kw}\\b`, 'i').test(trimmed)) {
      return `SQL must not contain ${kw}`;
    }
  }

  // UPDATE/DELETE must have WHERE (verb of the main statement, so a CTE-prefixed
  // UPDATE is held to the same rule).
  if ((verb === 'UPDATE' || verb === 'DELETE') && !upper.includes('WHERE')) {
    return `${operation === 'execute' ? 'UPDATE/DELETE' : 'Mutation'} SQL must have a WHERE clause`;
  }

  // operation match
  if (operation === 'query' && !isSelectLike) {
    return 'operation "query" must use SELECT';
  }
  if (operation === 'execute' && isSelectLike) {
    return 'operation "execute" must not use SELECT (use "query" instead)';
  }

  return null; // valid
}
