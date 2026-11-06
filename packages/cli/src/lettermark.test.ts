import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planIcons, renderLettermarkPng, writeDefaultIcons } from './lettermark.js';

describe('renderLettermarkPng', () => {
  it('is a deterministic square PNG that differs per lettermark', () => {
    const a = renderLettermarkPng('Hiring', 192);
    expect(a.readUInt32BE(16)).toBe(192);
    expect(a.readUInt32BE(20)).toBe(192);
    expect(a.equals(renderLettermarkPng('Hiring', 192))).toBe(true);
    expect(a.equals(renderLettermarkPng('DoorDrop', 192))).toBe(false);
    expect(renderLettermarkPng('Door Drop', 512).equals(renderLettermarkPng('DoorDrop', 512))).toBe(true);
  });
});

describe('writeDefaultIcons', () => {
  const FIXTURES = join(__dirname, '..', '..', 'compliance', 'src', '__fixtures__', 'template-icons');

  async function appDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'lettermark-'));
    await mkdir(join(dir, 'web', 'public'), { recursive: true });
    return dir;
  }

  it('replaces missing icons', async () => {
    const dir = await appDir();
    expect(await writeDefaultIcons(dir, 'Hiring')).toHaveLength(4);
    const png = await readFile(join(dir, 'web', 'public', 'icon-512.png'));
    expect(png.equals(renderLettermarkPng('Hiring', 512))).toBe(true);
  });

  it("replaces the template's F and placeholder icons", async () => {
    const dir = await appDir();
    await writeFile(join(dir, 'web', 'public', 'icon-192.png'), await readFile(join(FIXTURES, 'f-192.png')));
    await writeFile(join(dir, 'web', 'public', 'icon-512.png'), await readFile(join(FIXTURES, 'placeholder-512.png')));
    expect(await writeDefaultIcons(dir, 'Hiring')).toHaveLength(4);
    expect((await readFile(join(dir, 'web', 'public', 'icon-192.png'))).equals(renderLettermarkPng('Hiring', 192))).toBe(true);
  });

  it('leaves owner-supplied icons unchanged', async () => {
    const dir = await appDir();
    const custom = Buffer.from('custom-logo');
    await writeFile(join(dir, 'web', 'public', 'icon-192.png'), custom);
    await writeFile(join(dir, 'web', 'public', 'icon-512.png'), custom);
    expect(await writeDefaultIcons(dir, 'Hiring')).toHaveLength(2);
    expect((await readFile(join(dir, 'web', 'public', 'icon-192.png'))).equals(custom)).toBe(true);
  });
});

describe('planIcons', () => {
  it('classifies each icon as missing, template-default or custom', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lettermark-plan-'));
    await mkdir(join(dir, 'web', 'public'), { recursive: true });
    const fixtures = join(__dirname, '..', '..', 'compliance', 'src', '__fixtures__', 'template-icons');
    await writeFile(join(dir, 'web', 'public', 'icon-192.png'), await readFile(join(fixtures, 'f-192.png')));
    expect((await planIcons(dir)).map((p) => p.state)).toEqual(['template-default', 'missing']);
    await writeFile(join(dir, 'web', 'public', 'icon-512.png'), 'mine');
    expect((await planIcons(dir)).map((p) => p.state)).toEqual(['template-default', 'custom']);
  });
});

it('writes real PNG install, favicon and 180px Apple-touch outputs (#558)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'icons-558-'));
  await writeDefaultIcons(dir, 'Hiring');
  for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['favicon.ico', 192], ['apple-touch-icon.png', 180]] as const) {
    const bytes = await readFile(join(dir, 'web', 'public', file));
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
  }
});
