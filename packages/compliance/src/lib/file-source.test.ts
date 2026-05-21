import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(results).toHaveLength(19);
    const names = results.map((r) => r.name);
    expect(names).toContain('No unsafe 100vh');
    expect(names).toContain('Bundle size');
    expect(names).toContain('MIT License');
    expect(names).toContain('HTML meta tags');
    expect(names).toContain('Brand tokens defined');
    expect(names).toContain('CLAUDE.md is slim (no platform boilerplate)');
  });
});
