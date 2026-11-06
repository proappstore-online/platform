import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FONT, encodePng } from '@proappstore/compliance/icons';

const WIDTH = 1200;
const HEIGHT = 630;

export async function writeOgImage(path: string, appName: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderOgImagePng(appName));
}

export function renderOgImagePng(appName: string): Buffer {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const dx = x / WIDTH;
      const dy = y / HEIGHT;
      pixels[i] = Math.round(17 + 28 * dx + 28 * dy);
      pixels[i + 1] = Math.round(24 + 12 * dx + 8 * dy);
      pixels[i + 2] = Math.round(39 + 58 * dx + 26 * dy);
      pixels[i + 3] = 255;
    }
  }

  rect(pixels, 56, 56, 1088, 518, [255, 255, 255, 12]);
  rect(pixels, 80, 80, 1040, 470, [255, 255, 255, 18]);
  rect(pixels, 80, 80, 12, 470, [124, 58, 237, 255]);
  rect(pixels, 96, 96, 208, 12, [45, 212, 191, 255]);
  rect(pixels, 96, 522, 336, 12, [251, 191, 36, 255]);

  // This is an app-owned social preview. The generated image must not add
  // platform advertising to an app that chooses independent branding.
  const title = cleanText(appName || 'App');
  const titleScale = fitScale(title, 920, 18, 7);
  const titleWidth = textWidth(title, titleScale);
  drawText(pixels, title, Math.round((WIDTH - titleWidth) / 2), 215, titleScale, [255, 255, 255, 255]);

  return encodePng(WIDTH, HEIGHT, pixels);
}

function cleanText(value: string): string {
  const text = value.toUpperCase().replace(/[^A-Z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 28 ? `${text.slice(0, 25)}...` : text;
}

function fitScale(text: string, maxWidth: number, preferred: number, min: number): number {
  for (let scale = preferred; scale >= min; scale--) {
    if (textWidth(text, scale) <= maxWidth) return scale;
  }
  return min;
}

function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : text.length * 6 * scale - scale;
}

function drawText(pixels: Buffer, text: string, x: number, y: number, scale: number, color: number[]): void {
  let cursor = x;
  for (const char of text) {
    const glyph = FONT[char] ?? FONT[' ']!;
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy]!.length; gx++) {
        if (glyph[gy]![gx] !== '1') continue;
        rect(pixels, cursor + gx * scale, y + gy * scale, scale, scale, color);
      }
    }
    cursor += 6 * scale;
  }
}

function rect(pixels: Buffer, x: number, y: number, w: number, h: number, color: number[]): void {
  for (let yy = Math.max(0, y); yy < Math.min(HEIGHT, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(WIDTH, x + w); xx++) {
      const i = (yy * WIDTH + xx) * 4;
      const alpha = color[3]! / 255;
      pixels[i] = Math.round(color[0]! * alpha + pixels[i]! * (1 - alpha));
      pixels[i + 1] = Math.round(color[1]! * alpha + pixels[i + 1]! * (1 - alpha));
      pixels[i + 2] = Math.round(color[2]! * alpha + pixels[i + 2]! * (1 - alpha));
      pixels[i + 3] = 255;
    }
  }
}
