import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { GitHub } from '@proappstore/build-core';
import { renderLettermarkPng } from '@proappstore/compliance/icons';
import { scaffoldIcons } from './scaffold-icons.js';

const fixture = (size: number) => readFileSync(new URL(`../../compliance/src/__fixtures__/template-icons/f-${size}.png`, import.meta.url));
function github(custom = false) {
  return { api: vi.fn(async (path: string) => {
    if (path.endsWith('/marketing?ref=main')) return { ok: true, status: 200, data: [] };
    const match = path.match(/icon-(192|512)\.png/);
    if (!match) return { ok: false, status: 404, data: {} };
    return { ok: true, status: 200, data: { encoding: 'base64', content: (custom ? Buffer.from('custom') : fixture(Number(match[1]))).toString('base64') } };
  }) } as unknown as GitHub;
}
describe('scaffold icon generation (#558)', () => {
  it('renders personalized binary icons for app, marketing, favicon and Apple-touch', async () => {
    const files = await scaffoldIcons(github(), 'org', 'shop', 'Shop');
    expect(files).toHaveLength(6);
    for (const file of files) {
      const bytes = Buffer.from(file.content, 'base64');
      const size = file.path.includes('apple-touch') ? 180 : file.path.includes('512') ? 512 : 192;
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(bytes).toEqual(renderLettermarkPng('Shop', size));
      if (size !== 180) expect(bytes).not.toEqual(fixture(size));
    }
  });
  it('preserves custom install and marketing artwork', async () => {
    const files = await scaffoldIcons(github(true), 'org', 'shop', 'Shop');
    expect(files.map(f => f.path)).toEqual(['web/public/favicon.ico', 'web/public/apple-touch-icon.png']);
  });
  it('fails closed on an unreadable asset', async () => {
    const gh = github();
    vi.mocked(gh.api).mockResolvedValue({ ok: false, status: 503, data: {} });
    await expect(scaffoldIcons(gh, 'org', 'shop', 'Shop')).rejects.toThrow('Could not inspect');
  });
});
