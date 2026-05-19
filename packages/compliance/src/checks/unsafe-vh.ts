import type { FileSource } from '../lib/file-source.js';
import { stripCommentsForExt } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

/**
 * Flag `100vh` (and Tailwind shortcuts that compile to it) in source.
 *
 * Why: on iOS Safari with the URL bar visible, `100vh` resolves to the
 * *layout* viewport (e.g. 852px on iPhone 15) but the actual visible
 * area is the *visual* viewport (~750px). An element sized at `100vh`
 * is then ~100px taller than the screen, forcing the page to scroll on
 * first load. This is invisible to headless Playwright (no dynamic URL
 * bar) and to the static audit Worker (no rendering), so this fast
 * static rule is the cheapest place to catch it.
 *
 * Fix: use `100svh` (small viewport height — accounts for visible
 * browser UI) for "as tall as the screen" intent, or `100dvh` (dynamic
 * viewport height — recomputes as the URL bar shows/hides) for full-
 * height containers that should grow when chrome retracts.
 *
 * Scope: warn-by-default, not fail. There ARE legitimate uses of
 * `100vh` (intentionally taking layout-viewport height for hero
 * sections that should stay constant as URL bar moves). Creators can
 * acknowledge by leaving an `// allow-100vh` comment on the same line.
 */
export async function checkUnsafeVh(source: FileSource): Promise<CheckResult> {
  const issues: string[] = [];

  for await (const path of source.list()) {
    const ext = extOf(path);
    if (!SCAN_EXTS.has(ext)) continue;
    const raw = await source.read(path);
    if (!raw) continue;
    // Strip comments only, NOT string contents. JSX className values
    // are string literals (`<div className="h-screen">`) and IS the
    // live class assignment — erasing string contents would silently
    // miss the most common Tailwind usage. Accept the rare trade-off:
    // a `const docs = "100vh"` string-literal documentation example
    // still false-positive-warns; reviewer can add `// allow-100vh`.
    const content = stripCommentsForExt(raw, ext);

    for (const { re, label } of PATTERNS) {
      // Reset lastIndex defensively; we use `g` to find all matches.
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const line = lineNumberAt(raw, m.index);
        // Allow opt-out via an inline `allow-100vh` comment on the same
        // line. Read the raw source for the opt-out — the marker
        // necessarily lives in a comment that was just blanked from
        // `content`.
        if (lineHasAllowComment(raw, m.index)) continue;
        issues.push(`${path}:${line} ${label} — use 100svh or 100dvh`);
      }
    }
  }

  if (issues.length === 0) {
    return {
      name: 'No unsafe 100vh',
      status: 'pass',
      detail: 'no 100vh / h-screen patterns found',
    };
  }

  const head = issues.slice(0, MAX_REPORTED);
  const tail = issues.length > MAX_REPORTED ? [`...and ${issues.length - MAX_REPORTED} more`] : [];
  return {
    name: 'No unsafe 100vh',
    status: 'warn',
    detail: `${issues.length} occurrence${issues.length === 1 ? '' : 's'} of 100vh / h-screen — breaks on iOS Safari with URL bar visible`,
    suggestions: [
      ...head,
      ...tail,
      'Replace with 100svh (preferred) or 100dvh. Add `// allow-100vh` on the line if intentional.',
    ],
  };
}

const SCAN_EXTS = new Set(['.css', '.scss', '.tsx', '.ts', '.jsx', '.js', '.html']);
const MAX_REPORTED = 5;

/**
 * Patterns to flag. Each is global (`g`) so we find every occurrence.
 *
 * Boundary handling:
 * - `100vh` uses `\b` since CSS values are tokenised normally.
 * - Tailwind classes use a custom hyphen-aware boundary
 *   `(?<![\w-])foo(?![\w-])` so `h-screen` doesn't match inside
 *   `min-h-screen` (and we don't double-count `min-h-screen` as both
 *   itself and its `h-screen` substring).
 */
const PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b100vh\b/g, label: '100vh' },
  // Tailwind: h-screen → height: 100vh; same for min-/max-.
  { re: /(?<![\w-])h-screen(?![\w-])/g, label: 'h-screen (Tailwind: → 100vh)' },
  { re: /(?<![\w-])min-h-screen(?![\w-])/g, label: 'min-h-screen (Tailwind: → min-height: 100vh)' },
  { re: /(?<![\w-])max-h-screen(?![\w-])/g, label: 'max-h-screen (Tailwind: → max-height: 100vh)' },
];

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

function lineNumberAt(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * True if the rest of the line containing `index` includes the literal
 * string "allow-100vh" (typically inside a comment). Cheap and cheerful
 * — doesn't validate comment syntax, just trusts the marker.
 */
function lineHasAllowComment(content: string, index: number): boolean {
  let end = content.indexOf('\n', index);
  if (end === -1) end = content.length;
  let start = content.lastIndexOf('\n', index);
  if (start === -1) start = 0;
  return content.slice(start, end).includes('allow-100vh');
}
