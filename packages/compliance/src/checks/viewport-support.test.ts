import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkViewportSupport } from './viewport-support.js';

async function fixture(manifest: unknown | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fas-viewport-'));
  if (manifest !== null) {
    await mkdir(join(dir, 'web', 'public'), { recursive: true });
    await writeFile(join(dir, 'web', 'public', 'manifest.json'), JSON.stringify(manifest));
  }
  return dir;
}

describe('checkViewportSupport', () => {
  it('fails when manifest.json is missing', async () => {
    const dir = await fixture(null);
    const r = await checkViewportSupport(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/manifest\.json/);
  });

  it('fails when orientation is missing', async () => {
    const dir = await fixture({ name: 'x' });
    const r = await checkViewportSupport(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.suggestions?.join(' ')).toMatch(/orientation/);
  });

  it('fails when orientation is invalid', async () => {
    const dir = await fixture({ name: 'x', orientation: 'rotate' });
    const r = await checkViewportSupport(fsFileSource(dir));
    expect(r.status).toBe('fail');
  });

  it('warns when min_viewport_width is missing but orientation is valid', async () => {
    const dir = await fixture({ name: 'x', orientation: 'any' });
    const r = await checkViewportSupport(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/min_viewport_width/);
  });

  it('fails when min_viewport_width is below 320', async () => {
    const dir = await fixture({ name: 'x', orientation: 'any', min_viewport_width: 280 });
    const r = await checkViewportSupport(fsFileSource(dir));
    expect(r.status).toBe('fail');
  });

  it('warns on unusual but accepted widths', async () => {
    const dir = await fixture({ name: 'x', orientation: 'any', min_viewport_width: 387 });
    const r = await checkViewportSupport(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/unusual/);
  });

  it('passes for valid orientation + recommended width', async () => {
    const dir = await fixture({ name: 'x', orientation: 'any', min_viewport_width: 360 });
    const r = await checkViewportSupport(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/any/);
    expect(r.detail).toMatch(/360/);
  });

  it('passes for portrait-only landscape-only too', async () => {
    const dir = await fixture({ name: 'x', orientation: 'portrait', min_viewport_width: 414 });
    expect((await checkViewportSupport(fsFileSource(dir))).status).toBe('pass');
    const dir2 = await fixture({
      name: 'x',
      orientation: 'landscape-primary',
      min_viewport_width: 768,
    });
    expect((await checkViewportSupport(fsFileSource(dir2))).status).toBe('pass');
  });
});
