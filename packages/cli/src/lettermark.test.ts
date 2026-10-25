import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveLettermark, lettermarkLabel, renderLettermarkPng, writeDefaultIcons } from './lettermark.js';

describe('deriveLettermark', () => {
  it.each([
    ['Hiring', 'H'],
    ['hiring', 'H'],
    ['DoorDrop', 'DD'],
    ['doorDrop', 'DD'],
    ['Door Drop', 'DD'],
    ['door-drop', 'DD'],
    ['door_drop', 'DD'],
    ['  door   drop  ', 'DD'],
    ['Door.Drop!', 'DD'],
    ["Joe's Chess", 'JC'],
    ['Pro App Store', 'PA'],
    ['The Book of Hours', 'BH'],
    ['HTTPServer', 'HS'],
    ['Élan', 'E'],
    ['2fast', '2'],
    ['!!!', 'A'],
    ['', 'A'],
  ])('%s -> %s', (name, expected) => {
    expect(deriveLettermark(name)).toBe(expected);
  });
});

describe('lettermarkLabel', () => {
  it('exposes the full app name', () => {
    expect(lettermarkLabel('Door Drop')).toBe('Door Drop app icon');
    expect(lettermarkLabel('')).toBe('App app icon');
  });
});

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
  const TEMPLATE = join(__dirname, '..', '..', '..', '..', 'templates', 'template-map', 'web', 'public');

  async function appDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'lettermark-'));
    await mkdir(join(dir, 'web', 'public'), { recursive: true });
    return dir;
  }

  it('replaces missing icons', async () => {
    const dir = await appDir();
    expect(await writeDefaultIcons(dir, 'Hiring')).toHaveLength(2);
    const png = await readFile(join(dir, 'web', 'public', 'icon-512.png'));
    expect(png.equals(renderLettermarkPng('Hiring', 512))).toBe(true);
  });

  it('replaces the template F icons when the template checkout is present', async () => {
    const dir = await appDir();
    const f192 = await readFile(join(TEMPLATE, 'icon-192.png')).catch(() => null);
    if (!f192) return;
    await writeFile(join(dir, 'web', 'public', 'icon-192.png'), f192);
    expect(await writeDefaultIcons(dir, 'Hiring')).toContain(join(dir, 'web', 'public', 'icon-192.png'));
  });

  it('leaves owner-supplied icons unchanged', async () => {
    const dir = await appDir();
    const custom = Buffer.from('custom-logo');
    await writeFile(join(dir, 'web', 'public', 'icon-192.png'), custom);
    await writeFile(join(dir, 'web', 'public', 'icon-512.png'), custom);
    expect(await writeDefaultIcons(dir, 'Hiring')).toEqual([]);
    expect((await readFile(join(dir, 'web', 'public', 'icon-192.png'))).equals(custom)).toBe(true);
  });
});
