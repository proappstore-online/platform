import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkBrandFonts } from '../checks/brand-fonts.js';
import { checkNoTracking } from '../checks/no-tracking.js';
import { checkUnsafeVh } from '../checks/unsafe-vh.js';
import { runChecksFromFiles } from '../index.js';
import { fsFileSource, mapFileSource } from './file-source.js';

describe('fsFileSource', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fas-fs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists files with POSIX separators, skipping noise dirs', async () => {
    await mkdir(join(dir, 'web', 'src'), { recursive: true });
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'web', 'src', 'App.tsx'), 'x');
    await writeFile(join(dir, 'node_modules', 'junk.js'), 'x');

    const seen: string[] = [];
    for await (const p of fsFileSource(dir).list()) seen.push(p);
    expect(seen).toContain('web/src/App.tsx');
    expect(seen.some((p) => p.startsWith('node_modules'))).toBe(false);
  });

  it('read returns null for missing files', async () => {
    expect(await fsFileSource(dir).read('nope.txt')).toBeNull();
  });

  it('refuses path-traversal attempts', async () => {
    // Even if the target exists, `..`-containing paths must return null.
    const src = fsFileSource(dir);
    expect(await src.read('../etc/passwd')).toBeNull();
    expect(await src.read('foo/../../bar')).toBeNull();
    expect(await src.readBytes!('../secret')).toBeNull();
    expect(await src.listDir!('..')).toBeNull();
  });

  it('refuses absolute paths', async () => {
    const src = fsFileSource(dir);
    expect(await src.read('/etc/passwd')).toBeNull();
    expect(await src.read('C:/Windows/system32')).toBeNull();
  });
});

describe('mapFileSource', () => {
  it('list yields keys; skips noise dirs', async () => {
    const files = new Map<string, string>([
      ['web/src/App.tsx', 'export default function App() {}'],
      ['node_modules/junk.js', 'x'],
      ['dist/bundle.js', 'x'],
    ]);
    const seen: string[] = [];
    for await (const p of mapFileSource(files).list()) seen.push(p);
    expect(seen).toEqual(['web/src/App.tsx']);
  });

  it('read returns content for present paths, null for missing', async () => {
    const files = new Map([['a.txt', 'hello']]);
    const src = mapFileSource(files);
    expect(await src.read('a.txt')).toBe('hello');
    expect(await src.read('missing.txt')).toBeNull();
  });

  it('listDir synthesises directory entries from key prefixes', async () => {
    const files = new Map<string, string>([
      ['web/dist/assets/app-abc.js', 'x'],
      ['web/dist/assets/vendor.js', 'x'],
      ['web/dist/index.html', '<html/>'],
    ]);
    const src = mapFileSource(files);
    const entries = await src.listDir!('web/dist/assets');
    expect(entries?.sort()).toEqual(['app-abc.js', 'vendor.js']);
  });

  it('listDir returns null when nothing matches', async () => {
    const files = new Map<string, string>([['a.txt', 'x']]);
    expect(await mapFileSource(files).listDir!('web/dist/assets')).toBeNull();
  });

  it('parity: source-only checks return same result as fsFileSource', async () => {
    const files = new Map<string, string>([
      ['web/src/main.tsx', 'import "google-analytics";'],
      ['web/src/index.css', '/* no fonts here */'],
    ]);
    const tracking = await checkNoTracking(mapFileSource(files));
    expect(tracking.status).toBe('fail');

    const fonts = await checkBrandFonts(mapFileSource(files));
    expect(fonts.status).toBe('fail');
  });

  it('unsafe-vh catches 100vh + h-screen in source files', async () => {
    const files = new Map<string, string>([
      ['web/src/App.tsx', 'const cls = "h-screen flex"'],
      ['web/src/index.css', 'body { height: 100vh; }'],
    ]);
    const r = await checkUnsafeVh(mapFileSource(files));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/2 occurrences/);
  });

  it('runChecksFromFiles returns all checks', async () => {
    // Minimal "passing" virtual project — enough to not crash any check.
    const files = new Map<string, string>([
      ['package.json', '{"name":"x","packageManager":"pnpm@10"}'],
      ['web/index.html', '<!doctype html><link href="Manrope|Fraunces"/>'],
      [
        'web/public/manifest.json',
        JSON.stringify({
          name: 'x',
          short_name: 'x',
          start_url: '/',
          display: 'standalone',
          orientation: 'any',
          min_viewport_width: 360,
        }),
      ],
      ['web/src/index.css', '/* Manrope Fraunces */'],
    ]);
    const results = await runChecksFromFiles(files);
    expect(results).toHaveLength(20);
    const names = results.map((r) => r.name);
    expect(names).toContain('Accessibility static');
    expect(names).toContain('No unsafe 100vh');
    expect(names).toContain('Bundle size');
    expect(names).toContain('MIT License');
    expect(names).toContain('HTML meta tags');
    expect(names).toContain('Brand tokens defined');
    expect(names).toContain('CLAUDE.md is slim (no platform boilerplate)');
  });
});

// ── .gitignore handling (#122) ───────────────────────────────────────────────

/** Materialise a tree from a {path: contents} map and return its root. */
async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'compliance-walk-'));
  gitignoreRoots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, 'utf8');
  }
  return root;
}

const gitignoreRoots: string[] = [];

async function listed(root: string): Promise<string[]> {
  const out: string[] = [];
  for await (const p of fsFileSource(root).list()) out.push(p);
  return out.sort();
}

describe('fsFileSource — honours .gitignore (#122)', () => {
  afterEach(async () => {
    await Promise.all(
      gitignoreRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
    );
  });

  it('skips a git-ignored generated report but keeps real source', async () => {
    // The chess-academy failure exactly: a VCQA report whose inline CSS
    // redefines --muted/--accent and pulls in Inter. It is git-ignored, nobody
    // wrote it, and it failed `no-brand-overrides` for every developer who had
    // run the QA tool locally.
    const root = await tree({
      '.gitignore': 'node_modules\n.vibe-check/\n',
      '.vibe-check/report/actions.html':
        '<style>:root{--muted:#111;--accent:#f0f;font-family:inter}</style>',
      'src/app.css': ':root{--brand:#000}',
      'index.html': '<!doctype html>',
    });

    const files = await listed(root);
    expect(files).not.toContain('.vibe-check/report/actions.html');
    expect(files).toContain('src/app.css');
    expect(files).toContain('index.html');
  });

  it('honours negation, so an explicitly re-included file is still scanned', async () => {
    const root = await tree({
      '.gitignore': '*.log\n!keep.log\n',
      'debug.log': 'x',
      'keep.log': 'x',
    });
    const files = await listed(root);
    expect(files).not.toContain('debug.log');
    expect(files).toContain('keep.log');
  });

  it('applies a nested .gitignore to its own subtree only', async () => {
    const root = await tree({
      '.gitignore': '# root has no rules of its own\n',
      'web/.gitignore': 'out.txt\n',
      'web/out.txt': 'generated',
      'web/src.txt': 'source',
      'api/out.txt': 'not covered by web/.gitignore',
    });
    const files = await listed(root);
    expect(files).not.toContain('web/out.txt');
    expect(files).toContain('web/src.txt');
    expect(files).toContain('api/out.txt');
  });

  it('lets a deeper .gitignore re-include what the root excluded', async () => {
    const root = await tree({
      '.gitignore': '*.snap\n',
      'web/.gitignore': '!golden.snap\n',
      'web/golden.snap': 'kept',
      'api/other.snap': 'dropped',
    });
    const files = await listed(root);
    expect(files).toContain('web/golden.snap');
    expect(files).not.toContain('api/other.snap');
  });

  it('scans everything when there is no .gitignore at all', async () => {
    const root = await tree({ 'src/app.css': ':root{}', 'README.md': '# hi' });
    expect(await listed(root)).toEqual(['README.md', 'src/app.css']);
  });

  it('skips generated report dirs even without a .gitignore (SKIP_DIRS floor)', async () => {
    const root = await tree({
      '.vibe-check/report/quality.html': '<style>:root{--accent:#f0f}</style>',
      'playwright-report/index.html': '<style>:root{--muted:#111}</style>',
      'test-results/run.html': '<html>',
      'coverage/lcov-report/index.html': '<style>body{font-family:inter}</style>',
      '.vite/deps/chunk.js': 'export{}',
      'graphify-out/graph.html': '<html>',
      'src/real.css': ':root{}',
    });
    expect(await listed(root)).toEqual(['src/real.css']);
  });
});

describe('mapFileSource — deliberately ignores .gitignore (#122)', () => {
  it('scans a tracked file even when a .gitignore in the map names it', async () => {
    // Files reach this source via fetchRepoFiles, i.e. they are IN the repo.
    // Git ignore rules only ever applied to untracked files, so a tracked file
    // listed in .gitignore still ships — skipping it would teach the publish
    // gate to overlook real source.
    const files = new Map([
      ['.gitignore', 'analytics.js\n'],
      ['analytics.js', 'navigator.sendBeacon("https://tracker.example")'],
      ['src/app.css', ':root{}'],
    ]);
    const out: string[] = [];
    for await (const p of mapFileSource(files).list()) out.push(p);
    expect(out).toContain('analytics.js');
    expect(out).toContain('src/app.css');
  });

  it('still applies the SKIP_DIRS floor', async () => {
    const files = new Map([
      ['.vibe-check/report/actions.html', '<style>:root{--accent:#f0f}</style>'],
      ['node_modules/pkg/index.js', 'x'],
      ['src/app.css', ':root{}'],
    ]);
    const out: string[] = [];
    for await (const p of mapFileSource(files).list()) out.push(p);
    expect(out).toEqual(['src/app.css']);
  });
});
