import { Buffer } from 'node:buffer';
import { deriveLettermark } from './lettermark.js';
import { FONT, encodePng } from './png.js';
export { FONT, encodePng } from './png.js';
export { isTemplateDefaultIcon } from './default-icons.js';

/** Square full-bleed icon (safe for maskable use): gradient tile, centred lettermark. */
export function renderLettermarkPng(appName: string, size: number, letters = deriveLettermark(appName)): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = (x + y) / (2 * size);
      pixels[i] = Math.round(76 + 48 * d);
      pixels[i + 1] = Math.round(29 + 29 * d);
      pixels[i + 2] = Math.round(149 + 88 * d);
      pixels[i + 3] = 255;
    }
  }
  // Glyph cells are 5x7 with 1 cell of spacing; keep inside the 60% maskable safe zone.
  const cols = letters.length * 6 - 1;
  const scale = Math.max(1, Math.floor(Math.min((size * 0.6) / cols, (size * 0.6) / 7)));
  const x0 = Math.round((size - cols * scale) / 2);
  const y0 = Math.round((size - 7 * scale) / 2);
  let cursor = x0;
  for (const ch of letters) {
    const glyph = FONT[ch] ?? FONT[' ']!;
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy]![gx] !== '1') continue;
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            const i = ((y0 + gy * scale + py) * size + cursor + gx * scale + px) * 4;
            pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
          }
        }
      }
    }
    cursor += 6 * scale;
  }
  return encodePng(size, size, pixels);
}

