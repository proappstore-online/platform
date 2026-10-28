import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { planIcons, renderLettermarkPng } from './lettermark.js';

/** The app's display name: the manifest `name`, else package.json `name`, else the directory name. */
async function appNameFor(dir: string): Promise<string> {
  for (const file of ['pas.json', 'mcp.json', 'package.json']) {
    try {
      const name = (JSON.parse(await readFile(join(dir, file), 'utf8')) as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim() && name !== 'APPNAME') return name.trim();
    } catch { /* try the next file */ }
  }
  return resolve(dir).split(/[\\/]/).pop() ?? 'App';
}

export interface BrandIconsResult {
  appName: string;
  write: boolean;
  /** Template-default icons replaced (or that would be). */
  rewritten: string[];
  /** Icons left alone, with why. */
  skipped: { path: string; reason: string }[];
}

/**
 * `pas brand icons` (#505): give an existing app the lettermark of its name in place of the
 * template's icon. Only icons byte-identical to the ones the template shipped are rewritten;
 * custom and absent icons are never touched. icon-192 also serves as the favicon and
 * apple-touch icon, and the template's default og-image is artwork, not the old F, so the
 * set stays consistent. Dry-run unless `write`.
 */
export async function brandIcons(opts: { dir: string; write: boolean; name?: string | undefined }): Promise<BrandIconsResult> {
  const dir = resolve(opts.dir);
  const appName = opts.name ?? (await appNameFor(dir));
  const result: BrandIconsResult = { appName, write: opts.write, rewritten: [], skipped: [] };
  for (const { path, size, state } of await planIcons(dir)) {
    if (state !== 'template-default') {
      result.skipped.push({ path, reason: state === 'custom' ? 'custom icon, left as is' : 'not present, left as is' });
      continue;
    }
    if (opts.write) await writeFile(path, renderLettermarkPng(appName, size));
    result.rewritten.push(path);
  }
  return result;
}

export const brandCommand = new Command('brand').description('Default branding for an app that has not set its own.');

brandCommand
  .command('icons')
  .description("Replace the template's default icons with the app's lettermark. Dry-run unless --write; custom icons are never touched.")
  .option('--dir <path>', 'app repo root', '.')
  .option('--name <name>', "app name to derive the lettermark from (default: the app's manifest or package.json name)")
  .option('--write', 'apply the changes (default: report what would change)')
  .action(async (opts: { dir: string; name?: string; write?: boolean }) => {
    const r = await brandIcons({ dir: opts.dir, write: !!opts.write, name: opts.name });
    const out = process.stdout;
    out.write(`Lettermark source name: ${r.appName}\n`);
    for (const p of r.rewritten) out.write(`${r.write ? 'wrote' : 'would write'} ${p}\n`);
    for (const s of r.skipped) out.write(`skipped ${s.path}: ${s.reason}\n`);
    if (!r.rewritten.length) out.write('No template-default icons to replace.\n');
    else if (!r.write) out.write('\nDry run. Re-run with --write to apply.\n');
  });
