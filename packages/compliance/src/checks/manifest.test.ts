import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkManifest } from './manifest.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function withManifest(content: string): Promise<void> {
  await mkdir(join(dir, 'web', 'public'), { recursive: true });
  await writeFile(join(dir, 'web', 'public', 'manifest.json'), content);
}

describe('checkManifest', () => {
  it('fails when no manifest source (static OR inline) is present', async () => {
    const r = await checkManifest(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/no manifest source/);
  });

  it('fails when manifest.json is not valid JSON', async () => {
    await withManifest('{ not json');
    const r = await checkManifest(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/JSON/i);
  });

  it('warns when required fields are missing', async () => {
    await withManifest(JSON.stringify({ name: 'My App' }));
    const r = await checkManifest(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/short_name/);
    expect(r.detail).toMatch(/start_url/);
  });

  it('passes with all four required fields present', async () => {
    await withManifest(
      JSON.stringify({
        name: 'My App',
        short_name: 'MyApp',
        start_url: '/',
        display: 'standalone',
      }),
    );
    const r = await checkManifest(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('treats empty-string values for required fields as missing', async () => {
    await withManifest(
      JSON.stringify({ name: '', short_name: 'X', start_url: '/', display: 'standalone' }),
    );
    const r = await checkManifest(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/name/);
  });
});
