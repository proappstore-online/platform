import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkBrandFonts } from './brand-fonts.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-'));
  await mkdir(join(dir, 'web', 'src'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkBrandFonts', () => {
  it('passes when both Manrope and Fraunces are referenced', async () => {
    await writeFile(
      join(dir, 'web', 'src', 'index.css'),
      'body { font-family: Manrope, sans-serif; } h1 { font-family: Fraunces; }',
    );
    const r = await checkBrandFonts(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('passes with fonts split across files', async () => {
    await writeFile(join(dir, 'web', 'src', 'a.css'), '@import "Manrope";');
    await writeFile(join(dir, 'web', 'src', 'b.css'), '@import "Fraunces";');
    const r = await checkBrandFonts(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('passes when fonts are in HTML link tag (Google Fonts)', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      '<link href="https://fonts.googleapis.com/css2?family=Manrope&family=Fraunces" rel="stylesheet">',
    );
    const r = await checkBrandFonts(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('fails when only one of the two is present', async () => {
    await writeFile(join(dir, 'web', 'src', 'a.css'), '@import "Manrope";');
    const r = await checkBrandFonts(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/Fraunces/);
  });

  it('fails when neither is present', async () => {
    await writeFile(join(dir, 'web', 'src', 'a.css'), 'body { font: Helvetica; }');
    const r = await checkBrandFonts(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/Manrope/);
    expect(r.detail).toMatch(/Fraunces/);
  });
});
