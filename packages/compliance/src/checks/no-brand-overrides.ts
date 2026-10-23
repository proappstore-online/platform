import type { FileSource } from '../lib/file-source.js';
import { stripCommentsOnly, stripCssComments } from '../lib/strip.js';
import type { CheckResult } from '../types.js';
import { extOf, lineNumberAt } from '../lib/source-text.js';

/**
 * Brand colour tokens come from the template, not the app. This check fails
 * when an app redefines a platform-defined CSS variable (--paper, --ink,
 * --accent, --line, --line-strong, --panel, --muted) outside the canonical
 * theme file; such a redefinition changes the brand colours per app.
 *
 * Fonts are deliberately NOT checked here. The font rule has to stay for FAS
 * (Free App Store), because those store apps need to look consistent with
 * each other. PAS (ProAppStore) doesn't: every app is different, so apps may
 * use their own licensed fonts. The font half of this check was therefore
 * removed from the PAS compliance package only.
 *
 * What's allowed:
 *   - Using the variables (color: var(--accent)) — that's the whole point.
 *   - Any font-family declaration.
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
    // Strip comment bodies so a commented-out `--accent: red` note doesn't
    // fire. For .css/.scss use the css-only stripper (no `//` syntax at the
    // language level).
    const content =
      ext === '.css' || ext === '.scss' ? stripCssComments(raw) : stripCommentsOnly(raw);
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
      detail: 'apps inherit brand colour tokens from the template',
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

  return out;
}
