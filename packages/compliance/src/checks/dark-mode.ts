import type { FileSource } from '../lib/file-source.js';
import { isGameProject } from '../lib/project-type.js';
import { stripCommentsOnly, stripCssComments } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

/**
 * Apps on ProAppStore should respect the user's system colour-scheme
 * preference — dark interfaces are the default for many users on iOS
 * and recent Android. Returns `warn` (not `fail`) if no signal is
 * found because some apps are inherently visual (drawing canvas,
 * camera viewfinder) and don't have a colour scheme to switch.
 *
 * Accepted signals (any one passes):
 *   - `prefers-color-scheme` media query in CSS or JSX
 *   - `data-theme` attribute (manual toggle)
 *   - `color-scheme` CSS property
 *
 * Games are exempt — game UIs are full-bleed and pick their own
 * palette, so the system preference rarely applies. Skipped if
 * `@proappstore/games` is detected.
 */
export async function checkDarkMode(source: FileSource): Promise<CheckResult> {
  if (await isGameProject(source)) {
    return {
      name: 'Dark mode support',
      status: 'pass',
      detail: 'game project — check skipped',
    };
  }

  for await (const path of source.list()) {
    if (!path.startsWith('web/src/')) continue;
    if (!/\.(?:css|scss|tsx?|jsx?|html)$/i.test(path)) continue;
    const raw = await source.read(path);
    if (!raw) continue;
    // Strip comments so a `// We could use prefers-color-scheme` note
    // doesn't false-pass the check. Preserve string contents — the
    // signal might be in a template literal that injects CSS.
    const lower = path.toLowerCase();
    const content =
      lower.endsWith('.css') || lower.endsWith('.scss')
        ? stripCssComments(raw)
        : stripCommentsOnly(raw);
    if (/prefers-color-scheme|data-theme|color-scheme\s*:/i.test(content)) {
      return { name: 'Dark mode support', status: 'pass', detail: `signal in ${path}` };
    }
  }
  return {
    name: 'Dark mode support',
    status: 'warn',
    detail: 'no prefers-color-scheme / data-theme / color-scheme signal in web/src/',
    suggestions: [
      'Add a `@media (prefers-color-scheme: dark) { ... }` block to your theme CSS, or',
      'Use `color-scheme: light dark;` to opt the page into native scrollbars / form controls.',
    ],
  };
}
