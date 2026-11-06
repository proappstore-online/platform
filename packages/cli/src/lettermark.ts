import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ICON_SIZES, isTemplateDefaultIcon } from '@proappstore/compliance';
import { renderLettermarkPng } from '@proappstore/compliance/icons';
export { renderLettermarkPng } from '@proappstore/compliance/icons';

// The letters come from @proappstore/compliance (shared with the admin Worker and the Agent Teams
// seed); this file renders them to PNG and writes them into an app on disk.

type IconState = 'missing' | 'template-default' | 'custom';

export interface IconPlan {
  path: string;
  size: (typeof ICON_SIZES)[number];
  state: IconState;
}

/** What each icon in `<dir>/web/public` is: absent, byte-identical to the template's, or the owner's. */
export async function planIcons(dir: string, directory = 'web'): Promise<IconPlan[]> {
  const plans: IconPlan[] = [];
  for (const size of ICON_SIZES) {
    const path = join(dir, directory, 'public', `icon-${size}.png`);
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
  for (const [file, size] of [['favicon.ico', 192], ['apple-touch-icon.png', 180]] as const) {
    const path = join(dir, 'web', 'public', file);
    const current = await readFile(path).catch(() => null);
    if (current && !ICON_SIZES.some(s => isTemplateDefaultIcon(s, current))) continue;
    await writeFile(path, renderLettermarkPng(appName, size));
    written.push(path);
  }
  return written;
}
