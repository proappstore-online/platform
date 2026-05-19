import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkBundleSize } from './bundle-size.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeAsset(name: string, content: string | Buffer): Promise<void> {
  const p = join(dir, 'web', 'dist', 'assets');
  await mkdir(p, { recursive: true });
  await writeFile(join(p, name), content);
}

describe('checkBundleSize', () => {
  it('warns when web/dist not built', async () => {
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/pnpm build/);
  });

  it('warns when no JS files in assets', async () => {
    const p = join(dir, 'web', 'dist', 'assets');
    await mkdir(p, { recursive: true });
    await writeFile(join(p, 'styles.css'), 'body{color:red}');
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/no JS/);
  });

  it('passes when largest JS is under 300KB gzipped', async () => {
    // ~100KB of repetitive content gzips to a few KB
    await writeAsset('index-abc.js', 'a'.repeat(100_000));
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/index-abc\.js/);
    expect(r.detail).toMatch(/limit 300 KB/);
  });

  it('picks the largest JS file for measurement', async () => {
    await writeAsset('small.js', 'tiny');
    await writeAsset('big.js', 'a'.repeat(200_000));
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.detail).toMatch(/big\.js/);
  });

  it('fails when largest JS exceeds 300KB gzipped', async () => {
    // Random bytes don't compress, so 400KB of randomness ~= 400KB gzipped.
    const random = Buffer.alloc(400 * 1024);
    for (let i = 0; i < random.length; i++) random[i] = Math.floor(Math.random() * 256);
    await writeAsset('huge.js', random);
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.suggestions?.length ?? 0).toBeGreaterThan(0);
  });
});
