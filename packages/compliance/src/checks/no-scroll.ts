import type { FileSource } from '../lib/file-source.js';
import { isGameProject } from '../lib/project-type.js';
import type { CheckResult } from '../types.js';

/**
 * Games on ProAppStore must fit the viewport — no horizontal or
 * vertical scroll at the document level. Static analysis catches the
 * common CSS / inline-style anti-patterns:
 *
 *   - `overflow: scroll` or `overflow: auto` on `html` or `body`.
 *   - `min-height: 100vh` on `html` / `body` (creates page that's at
 *     least viewport-tall, but content + topbar = > 100vh = scroll).
 *   - Missing the `100svh` / `100vh` height constraint on the layout
 *     wrapper (loose check — "at least one root element should hard-cap
 *     to viewport height").
 *
 * Runtime guarantees (real DOM measurement) live in the e2e Playwright
 * suite; this check exists as a fast pre-publish gate so creators
 * don't ship trivially-scrolling games.
 *
 * Apps (ProAppStore) are not subject to this check — the apps Shell
 * wraps them in a sidebar+main layout that legitimately scrolls. We
 * detect "is this a game project" by looking for the @proappstore/games
 * dep, the canonical signal that the app uses GameShell.
 */
export async function checkNoScroll(source: FileSource): Promise<CheckResult> {
  // Skip apps — only games are subject to no-scroll.
  if (!(await isGameProject(source))) {
    return {
      name: 'No scroll (games only)',
      status: 'pass',
      detail: 'not a game project — check skipped',
    };
  }

  const issues: string[] = [];
  let sawViewportLock = false;

  for await (const path of source.list()) {
    const ext = extOf(path);
    if (!SCAN_EXTS.has(ext)) continue;
    const content = await source.read(path);
    if (!content) continue;

    for (const re of FORBIDDEN_OVERFLOW) {
      const m = re.exec(content);
      if (m) {
        const line = lineNumberAt(content, m.index);
        issues.push(`${path}:${line} ${m[0]} — root scrolling not allowed in games`);
      }
    }

    for (const re of FORBIDDEN_MIN_HEIGHT) {
      const m = re.exec(content);
      if (m) {
        const line = lineNumberAt(content, m.index);
        issues.push(`${path}:${line} ${m[0]} — use exact viewport height (100svh) instead`);
      }
    }

    if (VIEWPORT_LOCK.test(content)) sawViewportLock = true;

    if (issues.length >= 8) break;
  }

  if (issues.length > 0) {
    return {
      name: 'No scroll (games only)',
      status: 'fail',
      detail: `${issues.length} scroll-enabling pattern${issues.length === 1 ? '' : 's'}`,
      suggestions: [
        ...issues.slice(0, 5),
        ...(issues.length > 5 ? [`...and ${issues.length - 5} more`] : []),
        'Use <GameShell> from @proappstore/games — it locks layout to 100svh.',
        'Inside the play area, use overflow: hidden instead of overflow: auto.',
      ],
    };
  }

  if (!sawViewportLock) {
    return {
      name: 'No scroll (games only)',
      status: 'warn',
      detail: 'no 100svh/100vh viewport lock detected — game may scroll on small viewports',
      suggestions: [
        'Wrap your game in <GameShell> from @proappstore/games, or',
        'Add `height: 100svh` to your root container.',
      ],
    };
  }

  return {
    name: 'No scroll (games only)',
    status: 'pass',
    detail: 'viewport-locked layout detected',
  };
}

const SCAN_EXTS = new Set(['.css', '.scss', '.tsx', '.ts', '.jsx', '.js', '.html']);

const FORBIDDEN_OVERFLOW = [
  /(?:^|[\s,{])(?:html|body)\s*\{[^}]*overflow\s*:\s*(?:scroll|auto)/im,
  /(?:^|[\s,{])(?:html|body)\s*\{[^}]*overflow-(?:x|y)\s*:\s*(?:scroll|auto)/im,
];

const FORBIDDEN_MIN_HEIGHT = [/(?:^|[\s,{])(?:html|body)\s*\{[^}]*min-height\s*:\s*100vh/im];

const VIEWPORT_LOCK = /(?:height|max-height)\s*:\s*100(?:s?vh)|GameShell|@proappstore\/games/i;

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
