import { describe, expect, it } from 'vitest';
import { renderOgImagePng } from './og-image.js';

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
});
