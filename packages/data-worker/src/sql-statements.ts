/**
 * SQLite statement tokenizer and splitter (#455), shared by the data worker's
 * `/migrate` executor and the backend's migration lint, so they always agree on
 * where a statement starts and ends. Dependency-free: it runs inside every app's
 * data worker.
 *
 * It follows SQLite's own rules (lang_keywords, tokenize.c, and sqlite3_complete
 * for statement ends):
 *   - strings '…', quoted identifiers "…" `…` […], -- and block comments are
 *     single tokens or skipped, whatever they contain;
 *   - a `;` ends a statement, except inside CREATE TRIGGER. A trigger body is
 *     ended by the `;` after an `END` that itself follows a `;`, exactly as
 *     sqlite3_complete does. A `CASE … END` expression is therefore not mistaken
 *     for the end of the body (the bug that rejected valid triggers).
 *
 * The tokenizer is lenient: an unterminated string, identifier or comment becomes
 * a token with `error` set and runs to the end of the input, so the executor still
 * splits (and the database rejects) what it always did, while the lint reports it.
 */

type TokenKind = 'word' | 'ident' | 'string' | 'number' | 'punct';

export interface SqlToken {
  kind: TokenKind;
  /** The source text of the token. */
  text: string;
  /** Upper-cased `text` for a bare word (a keyword or an unquoted name); '' otherwise. */
  upper: string;
  /** Offset of the first character in the input. */
  start: number;
  /** Offset after the last character. */
  end: number;
  /** Set on an unterminated string, quoted identifier or block comment. */
  error?: string;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/;

/** Tokens of `sql`, comments dropped. Never throws. */
export function tokenize(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  const n = sql.length;
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number, error?: string): void => {
    const text = sql.slice(start, end);
    out.push({ kind, text, upper: kind === 'word' ? text.toUpperCase() : '', start, end, ...(error ? { error } : {}) });
  };
  while (i < n) {
    const ch = sql[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') { i++; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) {
        // An unterminated block comment swallows the rest, as SQLite reads it; flag it.
        push('punct', i, n, 'unterminated block comment');
        i = n;
      } else {
        i = close + 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          closed = true;
          j++;
          break;
        }
        j++;
      }
      push(ch === "'" ? 'string' : 'ident', i, j, closed ? undefined : `unterminated ${ch === "'" ? 'string literal' : 'quoted identifier'}`);
      i = j;
      continue;
    }
    if (ch === '[') {
      const close = sql.indexOf(']', i + 1);
      const end = close === -1 ? n : close + 1;
      push('ident', i, end, close === -1 ? 'unterminated [identifier]' : undefined);
      i = end;
      continue;
    }
    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j]!)) j++;
      push('word', i, j);
      i = j;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && sql[i + 1] !== undefined && sql[i + 1]! >= '0' && sql[i + 1]! <= '9')) {
      const m = NUMBER.exec(sql.slice(i, i + 64));
      const len = m ? m[0].length : 1;
      push('number', i, i + len);
      i += len;
      continue;
    }
    push('punct', i, i + 1);
    i++;
  }
  return out;
}

export interface SqlStatement {
  /** The statement's source, comments included, trimmed. */
  text: string;
  /** Its tokens (empty for a comment-only fragment). */
  tokens: SqlToken[];
  /** Offset of `text` in the input. */
  start: number;
}

/** Is `tokens[i]` the bare word `w`? */
function isWord(t: SqlToken | undefined, w: string): boolean {
  return t !== undefined && t.kind === 'word' && t.upper === w;
}

/** Does this statement begin CREATE [TEMP|TEMPORARY] TRIGGER? */
function startsTrigger(tokens: SqlToken[], from: number): boolean {
  if (!isWord(tokens[from], 'CREATE')) return false;
  let j = from + 1;
  if (isWord(tokens[j], 'TEMP') || isWord(tokens[j], 'TEMPORARY')) j++;
  return isWord(tokens[j], 'TRIGGER');
}

/**
 * Split a migration body into statements. The one tokenizer decides every
 * boundary. A `;` ends a statement unless it is inside a CREATE TRIGGER body, where
 * only a `;` after `END` after `;` does (sqlite3_complete's rule).
 */
export function parseStatements(sql: string): SqlStatement[] {
  const tokens = tokenize(sql);
  const out: SqlStatement[] = [];
  let first = 0; // index of the first token of the current statement
  let from = 0; // offset where the current statement's text begins
  let inTrigger = false;
  const flush = (endOffset: number, lastToken: number): void => {
    const text = sql.slice(from, endOffset).trim();
    if (text) out.push({ text, tokens: tokens.slice(first, lastToken), start: from + (sql.slice(from, endOffset).length - sql.slice(from, endOffset).trimStart().length) });
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (i === first) inTrigger = startsTrigger(tokens, first);
    if (t.kind === 'punct' && t.text === ';' && !t.error) {
      const endsTrigger = isWord(tokens[i - 1], 'END') && i - 2 >= first && tokens[i - 2]!.text === ';' && tokens[i - 2]!.kind === 'punct';
      if (inTrigger && !endsTrigger) continue;
      flush(t.start, i);
      first = i + 1;
      from = t.end;
      inTrigger = false;
    }
  }
  flush(sql.length, tokens.length);
  return out;
}

/**
 * The statements' source text, for the executor. Identical, by construction, to
 * what the migration lint sees.
 */
export function splitSqlStatements(sql: string): string[] {
  return parseStatements(sql).map((s) => s.text);
}
