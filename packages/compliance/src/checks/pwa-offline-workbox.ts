import { stripCommentsAndStrings } from '../lib/strip.js';

/**
 * Parse the numeric value assigned to `maximumFileSizeToCacheInBytes`.
 * Handles simple integer literals (`10485760`), underscore separators
 * (`10_485_760`), and `A * B * C` arithmetic chains that workbox docs
 * recommend (`10 * 1024 * 1024`). Returns null if the key isn't present
 * or the value isn't a recognisable arithmetic literal.
 */
export function parseBundleCap(workbox: string): number | null {
  const m = workbox.match(/maximumFileSizeToCacheInBytes\s*:\s*([^,\n}]+)/);
  if (!m) return null;
  const expr = (m[1] ?? '').trim().replace(/_/g, '');
  // Strict: only digits, *, whitespace. Anything else (variable
  // reference, function call) → can't evaluate, treat as unknown.
  if (!/^[\d*\s]+$/.test(expr)) return null;
  const parts = expr.split('*').map((s) => Number(s.trim()));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((a, b) => a * b, 1);
}

/**
 * Extracts the `{ ... }` body that follows the first match of `opener`,
 * walking the source character-by-character to balance braces.
 *
 * Two source views are required:
 *   - `src` — the real source, used for the returned substring.
 *   - `code` — the stripped view (comments/strings blanked) with the
 *     same character offsets as `src`. Used for matching the opener and
 *     counting braces, so that `}` in a string doesn't close the block.
 *
 * Regex alone can't handle this because workbox blocks contain nested
 * objects (`options: { expiration: {...} }`) and regex doesn't balance.
 */
export function extractBalancedBlock(
  src: string,
  code: string,
  opener: RegExp,
): string | null {
  const m = code.match(opener);
  if (!m || m.index === undefined) return null;
  let i = m.index + m[0].length; // start just after the `{`
  let depth = 1;
  const start = i;
  while (i < code.length) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
    i++;
  }
  return null;
}

/**
 * Parses every string literal in the workbox block, finds those that
 * look like glob patterns with a brace-expansion (e.g.
 * `**\/*.{js,css,wasm}`), and unions their extensions. Returns null if
 * no `globPatterns:` key is present at all.
 *
 * Bracket-balances the array body on a string-stripped view so that
 * glob bracket expressions like `**\/[abc]/*` don't truncate the array
 * — that `]` lives inside a string literal and isn't the array's close.
 */
export function extractCoveredExtensions(workbox: string): Set<string> | null {
  const workboxCode = stripCommentsAndStrings(workbox);
  const keyMatch = workboxCode.match(/globPatterns\s*:\s*\[/);
  if (!keyMatch || keyMatch.index === undefined) return null;
  // Walk the stripped view to find the matching `]` for this `[`.
  let i = keyMatch.index + keyMatch[0].length;
  const start = i;
  let depth = 1;
  while (i < workboxCode.length && depth > 0) {
    const c = workboxCode[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) return null;
  // Pull the real (un-stripped) array body so we still see the
  // quoted patterns.
  const arrayBody = workbox.slice(start, i);
  const covered = new Set<string>();
  for (const m of arrayBody.matchAll(/["']([^"']+)["']/g)) {
    const pattern = m[1] ?? '';
    const brace = pattern.match(/\{([^}]+)\}/);
    if (brace) {
      for (const ext of brace[1]!.split(',')) {
        covered.add(ext.trim().toLowerCase());
      }
    } else {
      // Bare pattern like "**/*.wasm" — extract the extension after the
      // last `.` (or the entire pattern if it's literally `**/*.wasm`).
      const ext = pattern.match(/\.([a-zA-Z0-9]+)$/);
      if (ext) covered.add(ext[1]!.toLowerCase());
    }
  }
  return covered;
}

export function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}
