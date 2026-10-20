import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #393: every staged template opts into private source maps the way ChessClubs
// does (chess-clubs#217) — hidden maps from Vite, none for the service worker or
// its precache, and the deploy's commit as `build.sha` — so an app made from one
// gets readable crash stacks from its first deploy, through the canonical
// workflow's upload and strip steps, and never serves a map.

const templates = ['template-workspace', 'template-map', 'template-membership'] as const;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe.each(templates)('%s source maps', (template) => {
  const vite = read(`templates/${template}/web/vite.config.ts`);
  const api = read(`templates/${template}/web/src/api.ts`);

  it('builds hidden maps: emitted for the private upload, never referenced from the bundle', () => {
    expect(vite).toMatch(/^\s*build:\s*\{\s*sourcemap:\s*'hidden'\s*\}/m);
    expect(vite).not.toMatch(/sourcemap:\s*true/);
  });

  it('gives the service worker no map and keeps maps out of its precache', () => {
    const workbox = vite.slice(vite.indexOf('workbox: {'));
    expect(workbox).toMatch(/^\s*sourcemap:\s*false,/m);
    const globs = /globPatterns:\s*\[([^\]]*)\]/.exec(workbox)?.[1] ?? '';
    expect(globs).not.toBe('');
    expect(globs).not.toMatch(/\bmap\b/);
  });

  it("names the build by the deploy's commit, which the canonical build exports", () => {
    expect(api).toMatch(/initPro\(\{[\s\S]*monitoring:\s*\{\s*build:\s*\{\s*sha:\s*import\.meta\.env\.VITE_COMMIT_SHA\s*\}\s*\}/);
    expect(read(`templates/${template}/.github/workflows/deploy.yml`)).toContain('VITE_COMMIT_SHA: ${{ github.sha }}');
  });
});
