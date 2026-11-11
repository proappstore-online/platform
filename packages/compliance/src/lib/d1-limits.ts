/**
 * D1's per-statement limits on registered action SQL (platform#571), shared by the
 * platform's registration gate (backend `lib/manifest/tool.ts`) and the
 * `mcp-d1-limits` compliance check, so `pas check`, an app's CI and the deploy
 * apply one rule.
 *
 * Local SQLite (`node:sqlite`: 32,766 variables, 500 compound terms) accepts SQL
 * that D1 refuses, so an action could register and then fail on its first live
 * call. Measured on Miniflare's D1 (miniflare 4.20250906.0):
 *
 * - **100 bound parameters per statement.** 100 run; 101 fail with `too many SQL
 *   variables`. The executor turns every `:name` occurrence into its own `?`
 *   (backend `lib/action-sql.ts` bindStatement), so a repeated `:name` counts
 *   once per occurrence. This counts with the executor's own pattern, over the
 *   raw text, exactly as it binds.
 * - **5 terms per compound SELECT.** 5 run; 6 fail with `too many terms in
 *   compound SELECT`, for `UNION`, `UNION ALL`, `INTERSECT` and `EXCEPT` alike.
 *   The limit is per compound chain: a chain inside parentheses (a subquery, a
 *   CTE body, an `IN (…)` list, including a `WITH RECURSIVE` body) is its own
 *   chain and does not add to the enclosing one, so nesting groups of at most 5
 *   runs any number of terms. Multi-row `VALUES` is not a compound and is not
 *   limited. Live D1 refused 10 terms and ran 4 (smsf, 2026-11-11).
 */

/** D1's maximum number of bound parameters in one statement. */
export const D1_MAX_BOUND_PARAMS = 100;
/** D1's maximum number of terms in one compound SELECT chain. */
export const D1_MAX_COMPOUND_TERMS = 5;

/** The executor's placeholder pattern (backend `lib/action-sql.ts` bindStatement). Keep the two equal. */
const PLACEHOLDER = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

const COMPOUND_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT']);

/** How many parameters the executor binds for this statement: one per `:name` occurrence. */
export function boundParamCount(sql: string): number {
  return [...sql.matchAll(PLACEHOLDER)].length;
}

/**
 * The most terms of any one compound SELECT chain in the statement. Each
 * parenthesised group is its own chain; keywords inside string literals, quoted
 * identifiers and comments are ignored. `UNION ALL` is one operator.
 */
export function maxCompoundTerms(sql: string): number {
  const operators = [0];
  let max = 0;
  const close = () => { max = Math.max(max, operators.pop()! + 1); };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const end = ch === '[' ? ']' : ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === end) {
          // A doubled quote inside a string or quoted identifier is an escaped quote.
          if (end !== ']' && sql[i + 1] === end) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 ? sql.length : eol + 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === '(') {
      operators.push(0);
      i++;
    } else if (ch === ')') {
      if (operators.length > 1) close();
      i++;
    } else if (/[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))![0];
      if (COMPOUND_OPERATORS.has(word.toUpperCase())) operators[operators.length - 1]!++;
      i += word.length;
    } else {
      i++;
    }
  }
  while (operators.length) close();
  return max;
}

/** Why D1 would refuse this statement, or null when it is within both limits. */
export function d1LimitError(sql: string): string | null {
  const params = boundParamCount(sql);
  if (params > D1_MAX_BOUND_PARAMS) {
    return `binds ${params} parameters; D1 allows at most ${D1_MAX_BOUND_PARAMS} per statement ("too many SQL variables"). ` +
      'Every :name occurrence is bound separately: repeat fewer, e.g. bind each value once in a one-row derived table ' +
      '(JOIN (SELECT :from AS d_from, :to AS d_to) p) and refer to p.d_from, or split the statement';
  }
  const terms = maxCompoundTerms(sql);
  if (terms > D1_MAX_COMPOUND_TERMS) {
    return `has a compound SELECT of ${terms} terms at one level; D1 allows at most ${D1_MAX_COMPOUND_TERMS} ("too many terms in compound SELECT"). ` +
      `Nest the union in groups of at most ${D1_MAX_COMPOUND_TERMS}: SELECT * FROM (a UNION ALL b UNION ALL c) UNION ALL SELECT * FROM (d UNION ALL e)`;
  }
  return null;
}

/** The first statement of an action that D1 would refuse, as an error naming the action and statement; null when all fit. */
export function actionD1LimitError(tool: { name: string; sql?: unknown; statements?: unknown }): string | null {
  const statements: [label: string, sql: unknown][] = [
    ['sql', tool.sql],
    ...(Array.isArray(tool.statements) ? tool.statements.map((s, i): [string, unknown] => [`statements[${i}]`, s]) : []),
  ];
  for (const [label, sql] of statements) {
    if (typeof sql !== 'string') continue;
    const error = d1LimitError(sql);
    if (error) return `action "${tool.name}" ${label} ${error}`;
  }
  return null;
}
