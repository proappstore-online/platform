import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { renderOgImagePng } from './og-image.js';

function rgbaAt(png: Buffer, x: number, y: number): number[] {
  const parts: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(parts));
  const start = y * (1200 * 4 + 1) + 1 + x * 4;
  return [...pixels.subarray(start, start + 4)];
}

describe('renderOgImagePng', () => {
  it('renders a valid 1200x630 PNG', () => {
    const png = renderOgImagePng('Chess Academy');

    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
  });

  it('does not add a platform wordmark to an app-owned preview', () => {
    const png = renderOgImagePng('Independent');
    // This pixel was inside the old PROAPPSTORE subtitle's first glyph.
    expect(rgbaAt(png, 405, 384)).not.toEqual([196, 181, 253, 255]);
  });

  it('keeps every platform-owned template preview on the neutral app-owned default', () => {
    const expected = renderOgImagePng('APP');
    for (const template of ['template-map', 'template-membership', 'template-workspace']) {
      expect(readFileSync(join(import.meta.dirname, '../../../templates', template, 'web/public/og-image.png'))).toEqual(expected);
    }
  });
});
