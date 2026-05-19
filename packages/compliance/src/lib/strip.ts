/**
 * Source-stripping helpers shared by checks that run regex against raw
 * source files. The whole class of bugs these prevent: a regex matches
 * a token (like `<meta name="viewport">`, `new Audio(`, `100vh`,
 * `@amplitude`) that lives inside a comment or a string literal —
 * never actually evaluated, but the static check fires anyway.
 *
 * Two design rules:
 *   1. All strippers preserve character positions — they replace
 *      removed bytes with spaces (newlines kept), so any `regex.index`
 *      result still refers to the same line/column in the real source.
 *   2. The strippers don't try to be a full tokenizer. They handle the
 *      common cases (escapes inside strings, nested comment-like text
 *      inside strings) and accept that pathological constructs
 *      (template-literal `${...}` containing braces, regex literals
 *      with asymmetric braces) need a real parser. In practice the
 *      compliance fixtures don't hit these.
 */

/** Replace `<!-- ... -->` comment bodies with spaces. */
export function stripHtmlComments(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    if (
      src[i] === '<' &&
      src[i + 1] === '!' &&
      src[i + 2] === '-' &&
      src[i + 3] === '-'
    ) {
      const start = i;
      i += 4;
      while (
        i < src.length &&
        !(src[i] === '-' && src[i + 1] === '-' && src[i + 2] === '>')
      )
        i++;
      i = Math.min(src.length, i + 3);
      blank(out, start, i);
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Replace JS/TS line + block comment bodies AND string-literal
 * contents with spaces. Use this when a regex against the source
 * shouldn't match documentation strings or commented-out code (the
 * common pattern: matching SDK names, API calls, CSS unit tokens).
 *
 * Handles single, double, and backtick strings with `\` escapes.
 * Doesn't track template-literal `${...}` interpolation contents and
 * doesn't recognise regex literals — both edge cases would need a
 * tokenizer.
 */
export function stripCommentsAndStrings(src: string): string {
  return stripCode(src, { strings: true });
}

/**
 * Like `stripCommentsAndStrings` but preserves string contents.
 * Use when the regex needs to see string values — e.g. inspecting
 * `font-family: "Comic Sans"` inside JSX, where the string value IS
 * the thing being audited.
 */
export function stripCommentsOnly(src: string): string {
  return stripCode(src, { strings: false });
}

/**
 * Replace `/* ... *​/` comment bodies with spaces. CSS doesn't have
 * `//` line comments at the language level (some preprocessors add
 * them, but plain CSS doesn't), so this is the simpler variant.
 */
export function stripCssComments(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(src.length, i + 2);
      blank(out, start, i);
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Dispatch to the right stripper based on file extension. For unknown
 * extensions, falls back to `stripCommentsAndStrings` (JS-style) —
 * conservative because most source files compliance checks touch are
 * JS-flavoured.
 */
export function stripForExt(src: string, ext: string): string {
  switch (ext.toLowerCase()) {
    case '.html':
    case '.htm':
      return stripHtmlComments(src);
    case '.css':
    case '.scss':
      return stripCssComments(src);
    case '.json':
      return src; // JSON has no comments
    default:
      return stripCommentsAndStrings(src);
  }
}

/**
 * Like `stripForExt` but preserves string-literal contents — useful
 * when the regex needs to match tokens that legitimately appear inside
 * strings (e.g. `@amplitude/` inside an `import from "@amplitude/..."`,
 * which is the literal package-name string we want to catch).
 */
export function stripCommentsForExt(src: string, ext: string): string {
  switch (ext.toLowerCase()) {
    case '.html':
    case '.htm':
      return stripHtmlComments(src);
    case '.css':
    case '.scss':
      return stripCssComments(src);
    case '.json':
      return src;
    default:
      return stripCommentsOnly(src);
  }
}

function stripCode(src: string, opts: { strings: boolean }): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i++;
      blank(out, start, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(src.length, i + 2);
      blank(out, start, i);
      continue;
    }
    if (opts.strings && (c === '"' || c === "'" || c === '`')) {
      const quote = c;
      const start = i + 1; // keep the opening quote in place
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) i++;
        i++;
      }
      blank(out, start, i);
      i++; // skip closing quote
      continue;
    }
    i++;
  }
  return out.join('');
}

function blank(out: string[], from: number, to: number): void {
  for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
}
