import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

const WIDTH = 1200;
const HEIGHT = 630;

const FONT: Record<string, string[]> = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '0': ['11111', '10001', '10011', '10101', '11001', '10001', '11111'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '11111'],
  '2': ['11111', '00001', '00001', '11111', '10000', '10000', '11111'],
  '3': ['11111', '00001', '00001', '11111', '00001', '00001', '11111'],
  '4': ['10001', '10001', '10001', '11111', '00001', '00001', '00001'],
  '5': ['11111', '10000', '10000', '11111', '00001', '00001', '11111'],
  '6': ['11111', '10000', '10000', '11111', '10001', '10001', '11111'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['11111', '10001', '10001', '11111', '10001', '10001', '11111'],
  '9': ['11111', '10001', '10001', '11111', '00001', '00001', '11111'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
};

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

  const title = cleanText(appName || 'Pro App');
  const titleScale = fitScale(title, 920, 18, 7);
  const titleWidth = textWidth(title, titleScale);
  drawText(pixels, title, Math.round((WIDTH - titleWidth) / 2), 215, titleScale, [255, 255, 255, 255]);

  const subtitle = 'PROAPPSTORE';
  const subtitleScale = 6;
  const subtitleWidth = textWidth(subtitle, subtitleScale);
  drawText(pixels, subtitle, Math.round((WIDTH - subtitleWidth) / 2), 384, subtitleScale, [196, 181, 253, 255]);

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

function encodePng(width: number, height: number, pixels: Buffer): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    scanlines[row] = 0;
    pixels.copy(scanlines, row + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.concat([
      u32(width),
      u32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  return Buffer.concat([u32(data.length), name, data, u32(crc32(Buffer.concat([name, data])))]);
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0, 0);
  return b;
}

const CRC_TABLE = Array.from({ length: 256 }, (_v, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
