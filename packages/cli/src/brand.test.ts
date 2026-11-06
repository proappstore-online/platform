import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brandIcons, writeMarketingIcons } from './brand.js';
import { renderLettermarkPng } from './lettermark.js';

// #505: `pas brand icons` rewrites only template-default icons, and only with --write.

const FIXTURES = join(__dirname, '..', '..', 'compliance', 'src', '__fixtures__', 'template-icons');

async function app(icons: Record<string, Buffer | string>, name = 'Door Drop'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'brand-'));
  await mkdir(join(dir, 'web', 'public'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name }));
  for (const [f, b] of Object.entries(icons)) await writeFile(join(dir, 'web', 'public', f), b);
  return dir;
}
const png = (dir: string, f: string) => readFile(join(dir, 'web', 'public', f));

describe('pas brand icons (#505)', () => {
  it('is a dry run by default: reports the template-default icons and writes nothing', async () => {
    const f192 = await readFile(join(FIXTURES, 'f-192.png'));
    const dir = await app({ 'icon-192.png': f192, 'icon-512.png': await readFile(join(FIXTURES, 'f-512.png')) });
    const r = await brandIcons({ dir, write: false });
    expect(r.rewritten).toHaveLength(2);
    expect((await png(dir, 'icon-192.png')).equals(f192)).toBe(true);
  });

  it('--write replaces a template-default fixture with the lettermark of the app name, both sizes consistently', async () => {
    const dir = await app({ 'icon-192.png': await readFile(join(FIXTURES, 'f-192.png')), 'icon-512.png': await readFile(join(FIXTURES, 'placeholder-512.png')) });
    const r = await brandIcons({ dir, write: true });
    expect(r.appName).toBe('Door Drop');
    expect((await png(dir, 'icon-192.png')).equals(renderLettermarkPng('Door Drop', 192))).toBe(true);
    expect((await png(dir, 'icon-512.png')).equals(renderLettermarkPng('Door Drop', 512))).toBe(true);
  });

  it('never touches a custom icon, written or not, and does not create absent ones', async () => {
    const custom = Buffer.from('owner-logo');
    const dir = await app({ 'icon-192.png': custom });
    const r = await brandIcons({ dir, write: true });
    expect(r.rewritten).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['custom icon, left as is', 'not present, left as is', 'not present, left as is', 'not present, left as is']);
    expect((await png(dir, 'icon-192.png')).equals(custom)).toBe(true);
    await expect(png(dir, 'icon-512.png')).rejects.toThrow();
  });

  it('is idempotent: a second --write changes nothing', async () => {
    const dir = await app({ 'icon-192.png': await readFile(join(FIXTURES, 'f-192.png')), 'icon-512.png': await readFile(join(FIXTURES, 'f-512.png')) });
    await brandIcons({ dir, write: true });
    expect((await brandIcons({ dir, write: true })).rewritten).toEqual([]);
  });

  it('takes the name from --name over the manifest', async () => {
    const dir = await app({ 'icon-192.png': await readFile(join(FIXTURES, 'f-192.png')) });
    expect((await brandIcons({ dir, write: false, name: 'Hiring' })).appName).toBe('Hiring');
  });
});

describe('marketing icons (#558)', () => {
  it('previews and replaces default marketing PNGs with personalized bytes', async () => {
    const dir = await app({});
    await mkdir(join(dir, 'marketing', 'public'), { recursive: true });
    const original = await readFile(join(FIXTURES, 'f-192.png'));
    await writeFile(join(dir, 'marketing', 'public', 'icon-192.png'), original);
    const path = join(dir, 'marketing', 'public', 'icon-192.png');
    expect((await brandIcons({ dir, write: false })).rewritten).toContain(path);
    expect(await readFile(path)).toEqual(original);
    await brandIcons({ dir, write: true });
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(bytes).not.toEqual(original);
    expect(bytes).toEqual(renderLettermarkPng('Door Drop', 192));
  });
  it('preserves custom marketing artwork, including when filling missing variants', async () => {
    const dir = await app({});
    await mkdir(join(dir, 'marketing', 'public'), { recursive: true });
    const path = join(dir, 'marketing', 'public', 'icon-192.png');
    await writeFile(path, 'custom artwork');
    await brandIcons({ dir, write: true });
    await writeMarketingIcons(dir, 'Door Drop');
    expect(await readFile(path, 'utf8')).toBe('custom artwork');
    expect(await readFile(join(dir, 'marketing', 'public', 'icon-512.png'))).toEqual(renderLettermarkPng('Door Drop', 512));
  });
});
