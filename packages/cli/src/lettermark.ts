import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FONT, encodePng } from './og-image.js';

/** sha256 of the template-shipped "F" icons — only these are ever overwritten on regeneration. */
const DEFAULT_ICON_SHA256: Record<number, string> = {
  192: '068ce0b22606087c2bf67ee3125a7b18522f2ec95a762f5fe2be104fcacc5384',
  512: 'ebe6d029764e050f2d2229d5516dec4d5b7f488ff18961db0c757687247c10a6',
};

const ICON_SIZES = [192, 512] as const;
const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to']);

/**
 * Deterministic lettermark: one letter for a single word, the first two
 * initials for several (Hiring -> H, DoorDrop / Door Drop / door-drop -> DD).
 */
export function deriveLettermark(appName: string): string {
  const ascii = appName.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const words = ascii
    .replace(/['\u2019]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  const picked = meaningful.length > 0 ? meaningful : words;
  if (picked.length === 0) return 'A';
  return picked
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/** Accessible name for the icon: the full app name, never just the initials. */
export function lettermarkLabel(appName: string): string {
  return `${appName.trim() || 'App'} app icon`;
}

/** Square full-bleed icon (safe for maskable use): gradient tile, centred lettermark. */
export function renderLettermarkPng(appName: string, size: number): Buffer {
  const letters = deriveLettermark(appName);
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

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Write the derived icons into `<dir>/web/public`. A file is replaced only when
 * absent or byte-identical to the template default, so owner-supplied icons
 * survive. Returns the files written.
 */
export async function writeDefaultIcons(dir: string, appName: string): Promise<string[]> {
  const publicDir = join(dir, 'web', 'public');
  await mkdir(publicDir, { recursive: true });
  const written: string[] = [];
  for (const size of ICON_SIZES) {
    const path = join(publicDir, `icon-${size}.png`);
    const current = await readFile(path).catch(() => null);
    if (current && sha256(current) !== DEFAULT_ICON_SHA256[size]) {
      // Re-running for the same name is a no-op; anything else is custom branding.
      continue;
    }
    await writeFile(path, renderLettermarkPng(appName, size));
    written.push(path);
  }
  return written;
}
