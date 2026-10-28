import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveLettermark, ICON_SIZES, isTemplateDefaultIcon } from '@proappstore/compliance';
import { FONT, encodePng } from './og-image.js';

// The letters come from @proappstore/compliance (shared with the admin Worker and the Agent Teams
// seed); this file renders them to PNG and writes them into an app on disk.

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

type IconState = 'missing' | 'template-default' | 'custom';

export interface IconPlan {
  path: string;
  size: (typeof ICON_SIZES)[number];
  state: IconState;
}

/** What each icon in `<dir>/web/public` is: absent, byte-identical to the template's, or the owner's. */
export async function planIcons(dir: string): Promise<IconPlan[]> {
  const plans: IconPlan[] = [];
  for (const size of ICON_SIZES) {
    const path = join(dir, 'web', 'public', `icon-${size}.png`);
    const current = await readFile(path).catch(() => null);
    const state: IconState = !current ? 'missing' : isTemplateDefaultIcon(size, current) ? 'template-default' : 'custom';
    plans.push({ path, size, state });
  }
  return plans;
}

/**
 * Write the derived icons into `<dir>/web/public`. A file is replaced only when
 * absent or byte-identical to the template default, so owner-supplied icons
 * survive. Returns the files written.
 */
export async function writeDefaultIcons(dir: string, appName: string): Promise<string[]> {
  await mkdir(join(dir, 'web', 'public'), { recursive: true });
  const written: string[] = [];
  for (const { path, size, state } of await planIcons(dir)) {
    if (state === 'custom') continue; // re-running for the same name is a no-op; anything else is custom branding
    await writeFile(path, renderLettermarkPng(appName, size));
    written.push(path);
  }
  return written;
}
