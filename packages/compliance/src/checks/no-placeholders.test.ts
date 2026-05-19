import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkNoPlaceholders } from './no-placeholders.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkNoPlaceholders', () => {
  it('passes when no APPNAME anywhere', async () => {
    await writeFile(join(dir, 'README.md'), '# my-app\nNo placeholders here.');
    await writeFile(join(dir, 'package.json'), '{"name":"my-app"}');
    const r = await checkNoPlaceholders(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('fails with file list when APPNAME is left in any text file', async () => {
    await writeFile(join(dir, 'README.md'), '# APPNAME\n');
    await mkdir(join(dir, 'web'));
    await writeFile(join(dir, 'web', 'index.html'), '<title>APPNAME — ProAppStore</title>');
    const r = await checkNoPlaceholders(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/README\.md/);
    expect(r.detail).toMatch(/index\.html/);
    expect(r.suggestions?.length ?? 0).toBeGreaterThan(0);
  });

  it('skips binary-ish extensions (no false positives on icons etc.)', async () => {
    // .png file with bytes that happen to spell APPNAME — should be skipped
    await writeFile(join(dir, 'icon.png'), Buffer.from('APPNAME'));
    const r = await checkNoPlaceholders(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('caps at 5 reported files when many offend', async () => {
    await mkdir(join(dir, 'web'));
    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, 'web', `file${i}.ts`), 'const x = "APPNAME";');
    }
    const r = await checkNoPlaceholders(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/5\+/);
  });
});
