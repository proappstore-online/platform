import type { FileSource } from '../lib/file-source.js';
import { stripCommentsOnly, stripCssComments } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

/**
 * Apps and games on the platform must look consistent with the storefront
 * and with each other — brand colors, fonts, and layout rhythm come from
 * the template, not the app. This check fails on the most common forms of
 * brand-override drift:
 *
 *   1. Custom CSS variable overrides for the platform-defined tokens
 *      (--paper, --ink, --accent, --line, --panel, --muted). These are
 *      defined by the template; an app redefining them changes the brand.
 *   2. Custom font-family declarations beyond the brand stack
 *      (Manrope, Fraunces) and the system / monospace fallbacks.
 *
 * What's allowed:
 *   - Using the variables (color: var(--accent)) — that's the whole point.
 *   - Hardcoded colors for non-brand purposes (highlight states, error
 *     red, etc.). We don't try to gate every hex literal — too noisy and
 *     too many false positives.
 */
export async function checkNoBrandOverrides(source: FileSource): Promise<CheckResult> {
  const issues: string[] = [];

  for await (const path of source.list()) {
    const ext = extOf(path);
    if (!SCANNED_EXTS.has(ext)) continue;
    const raw = await source.read(path);
    if (!raw) continue;
    // Strip comment bodies so a `// font-family: "Comic Sans"` note
    // doesn't fire. Preserve string-literal contents — the JSX value
    // `fontFamily: "Comic Sans"` IS a string literal and is the thing
    // we're auditing. For .css/.scss use the css-only stripper (no `//`
    // syntax at the language level).
    const content =
      ext === '.css' || ext === '.scss'
        ? stripCssComments(raw)
        : stripCommentsOnly(raw);
    // Canonical theme file: the platform's CSS variables ARE defined here.
    // Apps own this file post-scaffold (they can technically modify token
    // values, and we accept the imperfection — the loud places where a
    // brand override actually causes inconsistency are inline styles +
    // per-component CSS, which this check still covers).
    const isThemeFile = path === 'web/src/index.css' || path === 'web/src/main.css';
    const fileIssues = scanContent(path, content, { skipVarRedefs: isThemeFile });
    issues.push(...fileIssues);
    // Cap at 10 — beyond that the user has bigger problems and we don't
    // want a 200-line failure report.
    if (issues.length >= 10) break;
  }

  if (issues.length === 0) {
    return {
      name: 'No brand overrides',
      status: 'pass',
      detail: 'apps inherit colors + fonts from the template',
    };
  }
  return {
    name: 'No brand overrides',
    status: 'fail',
    detail: `${issues.length} apparent override${issues.length === 1 ? '' : 's'}`,
    suggestions: [
      ...issues.slice(0, 5),
      ...(issues.length > 5 ? [`...and ${issues.length - 5} more`] : []),
      'Use the template tokens (var(--accent), var(--ink), etc.) instead of redefining them.',
      'Brand fonts are Manrope (body) + Fraunces (display). Stick to those + system / monospace.',
    ],
  };
}

const SCANNED_EXTS = new Set(['.css', '.scss', '.tsx', '.ts', '.jsx', '.js', '.html']);

const PROTECTED_VARS = new Set([
  '--paper',
  '--ink',
  '--muted',
  '--accent',
  '--line',
  '--line-strong',
  '--panel',
]);

/**
 * Whitelist of font-family declarations we accept. Anything outside this
 * set — for ANY font name not in the brand stack and not a generic /
 * system fallback — flags. The check is case-insensitive.
 */
const ALLOWED_FONT_TOKENS = new Set([
  // Brand stack
  'manrope',
  'fraunces',
  // Generic/system fallbacks (CSS keywords)
  'serif',
  'sans-serif',
  'monospace',
  'system-ui',
  'ui-monospace',
  'ui-serif',
  'ui-sans-serif',
  'inherit',
  'initial',
  'unset',
  'revert',
  // Common system stack names — these are aliases, not custom fonts.
  '-apple-system',
  'blinkmacsystemfont',
  'segoe ui',
  'roboto',
  'helvetica',
  'helvetica neue',
  'arial',
  'sf mono',
  'sf pro',
  'menlo',
  'monaco',
  'consolas',
  'liberation mono',
  'courier',
  'courier new',
  'georgia',
  'noto sans',
  'noto color emoji',
  'apple color emoji',
  'segoe ui emoji',
  'segoe ui symbol',
]);

export function scanContent(
  filename: string,
  content: string,
  opts: { skipVarRedefs?: boolean } = {},
): string[] {
  const out: string[] = [];

  // 1. CSS variable overrides for protected tokens.
  if (!opts.skipVarRedefs) {
    const varDeclRe = /(?:^|[\s;{,])(--[a-z-]+)\s*:/gim;
    let m: RegExpExecArray | null;
    while ((m = varDeclRe.exec(content)) !== null) {
      const name = m[1]!;
      if (PROTECTED_VARS.has(name)) {
        const line = lineNumberAt(content, m.index);
        out.push(`${filename}:${line} redefines ${name} (template owns this token)`);
      }
    }
  }

  // 2. font-family overrides.
  // Capture the value of every font-family / fontFamily declaration, then
  // extract candidate font names. JSX values can be ternaries
  // (`fontFamily: isFoo ? "Fraunces" : "Manrope"`), so we pull out every
  // quoted string in the value and check each one separately. If there are
  // no quoted strings, the value is treated as a CSS-style comma list
  // (`font-family: Comic Sans, serif`).
  const fontHeadRe = /(font-family|fontFamily)\s*[:=]/g;
  const quotedRe = /(['"`])([^'"`\n]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = fontHeadRe.exec(content)) !== null) {
    const isJsx = m[1] === 'fontFamily';
    const start = m.index + m[0].length;
    const value = sliceFontValue(content, start, isJsx);
    const quotedStrings = [...value.matchAll(quotedRe)].map((x) => x[2]!);
    const candidates = quotedStrings.length > 0 ? quotedStrings : [value];
    let flagged = false;
    for (const cand of candidates) {
      const tokens = cand
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, '').toLowerCase())
        .filter(Boolean);
      for (const t of tokens) {
        if (!ALLOWED_FONT_TOKENS.has(t)) {
          const line = lineNumberAt(content, m.index);
          out.push(`${filename}:${line} non-brand font "${t}"`);
          flagged = true;
          break;
        }
      }
      if (flagged) break;
    }
  }

  return out;
}

/**
 * Walk forward from `start` until we hit the end of the font-family value.
 *
 * CSS values end at `;` or `}` or newline.
 * JSX values end at `}` or at a `,` followed by another identifier+colon
 * (the next style property). Commas inside quoted strings or before
 * non-identifiers (e.g. font fallbacks) are part of the value.
 */
function sliceFontValue(content: string, start: number, isJsx: boolean): string {
  let i = start;
  let quote: string | null = null;
  while (i < content.length) {
    const c = content[i]!;
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      i++;
      continue;
    }
    if (c === '\n' || c === ';' || c === '}') break;
    if (isJsx && c === ',') {
      // Lookahead: is this `,` followed by `identifier:`? If yes, end of value.
      let j = i + 1;
      while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
      const rest = content.slice(j, j + 64);
      if (/^[A-Za-z_$][\w$]*\s*:/.test(rest)) break;
    }
    i++;
  }
  return content.slice(start, i);
}

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
