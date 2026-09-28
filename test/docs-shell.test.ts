import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #238 — the published docs teach one way to build an app: wrap it in ProShell
 * and declare its screens with `nav`. A doc that shows an app root without the
 * shell, or frames navigation as optional, teaches a human or a crawling AI to
 * ship a nav-less app. These tests hold the docs to the shell as it ships.
 */

const ROOT = resolve(__dirname, '..');
const DOCS = join(ROOT, 'docs');

function mdFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return []; // .vitepress (config + build output)
    const p = join(dir, e.name);
    return e.isDirectory() ? mdFiles(p) : e.name.endsWith('.md') ? [p] : [];
  });
}

/** Developer-facing pages: the published docs plus the SDK README shipped to npm. */
const PAGES = [...mdFiles(DOCS), join(ROOT, 'packages/sdk/README.md')];
const read = (p: string) => readFileSync(p, 'utf8');
const rel = (p: string) => relative(ROOT, p);

function codeBlocks(md: string): string[] {
  return [...md.matchAll(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)].map((m) => m[2]!);
}

/** Heading slugs as the docs site generates them. */
function headingSlugs(md: string): Set<string> {
  const withoutCode = md.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
  return new Set([...withoutCode.matchAll(/^#{1,6}\s+(.+?)\s*(?:\{#[^}]+\})?\s*$/gm)].map((m) =>
    m[1]!.toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-'),
  ));
}

describe('docs: apps are built inside ProShell (#238)', () => {
  it('every code example that defines the app root wraps it in <ProShell … nav>', () => {
    const roots = /export default function App\b|export default \(\) =>|^function App\s*\(/m;
    let seen = 0;
    for (const page of PAGES) {
      for (const block of codeBlocks(read(page))) {
        if (!roots.test(block)) continue;
        seen++;
        expect(block, `${rel(page)}: app root without ProShell`).toMatch(/<ProShell\b/);
        expect(block, `${rel(page)}: ProShell without nav`).toMatch(/<ProShell\b[^>]*\bnav=/);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('no page frames the shell as for simple apps or navigation as an advanced opt-in', () => {
    const framings = [/for simple apps,? use the default shell/i, /navigation is (?:optional|advanced)/i];
    for (const page of PAGES) {
      for (const re of framings) expect(read(page), rel(page)).not.toMatch(re);
    }
  });

  it('the standard no longer says ProShell lacks a nav landmark, skip link or route title', () => {
    for (const page of mdFiles(join(DOCS, 'standard'))) {
      if (page.endsWith('changelog.md')) continue; // history may quote what changed
      expect(read(page), rel(page)).not.toMatch(/ProShell[^.]*\b(?:lacks|does not provide|doesn't provide|has no)\b[^.]*\b(?:nav|skip|title)/i);
    }
  });
});

describe('docs: the canonical entry point leads with the shell (#238)', () => {
  const gettingStarted = read(join(DOCS, 'getting-started.md'));

  it('Getting Started wraps the app in ProShell with nav before anything else is built', () => {
    const shell = gettingStarted.indexOf('## Build your app inside ProShell');
    expect(shell).toBeGreaterThan(-1);
    expect(shell).toBeLessThan(gettingStarted.indexOf('## Tech stack'));
    expect(shell).toBeLessThan(gettingStarted.indexOf('## SDK'));
  });

  it('the home page and llms.txt send readers to it', () => {
    expect(read(join(DOCS, 'index.md'))).toContain('./getting-started.md#build-your-app-inside-proshell');
    const llms = read(join(DOCS, 'llms.txt'));
    expect(llms).toContain('getting-started/#build-your-app-inside-proshell');
    expect(llms.indexOf('## Build an app')).toBeLessThan(llms.indexOf('## Agent Skills'));
  });

  it('every link to a shell section resolves to a heading', () => {
    const targets: Record<string, string> = { 'getting-started': 'getting-started.md', 'sdk-overview': 'sdk-overview.md', ui: 'ui.md' };
    const slugs = Object.fromEntries(Object.entries(targets).map(([k, f]) => [k, headingSlugs(read(join(DOCS, f)))]));
    let checked = 0;
    for (const page of [...PAGES, join(DOCS, 'llms.txt')]) {
      const text = read(page);
      const self = Object.entries(targets).find(([, f]) => page === join(DOCS, f))?.[0];
      const links = [
        ...[...text.matchAll(/\]\((?:\.\.?\/|\/|https:\/\/docs\.proappstore\.online\/)?(getting-started|sdk-overview|ui)(?:\.md|\/)?#([a-z0-9-]+)\)/g)].map((m) => [m[1]!, m[2]!]),
        ...(self ? [...text.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((m) => [self, m[1]!]) : []),
      ];
      for (const [doc, anchor] of links) {
        if (!/proshell|shell|navigation|routing|render|migrating|choose-your-level/.test(anchor!)) continue;
        checked++;
        expect(slugs[doc!]!.has(anchor!), `${rel(page)} → ${doc}#${anchor}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});
