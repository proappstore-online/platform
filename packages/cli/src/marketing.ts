import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { Command } from 'commander';
import { exists, resolveTemplate, run } from './create.js';
import { readConfig } from './lib/config.js';
import { readJsonIfExists } from './lib/json-file.js';
import { toTitleCase } from './lib/title-case.js';

/**
 * `pas marketing add` (#410): add the Astro marketing site from template-app
 * (#407) to an existing app repo, never overwriting a file that is already
 * there. The folder stays outside the pnpm workspace, so the app's lockfile and
 * its frozen install are untouched; the canonical deploy installs and builds it
 * on its own and publishes it to https://about-<app>.proappstore.online/ (#408).
 */

/** The public listing fields the site is pre-filled from. */
export interface MarketingListing {
  tagline?: string | null;
  longDescription?: string | null;
  themeColor?: string | null;
  supportUrl?: string | null;
}

export interface AddMarketingOptions {
  /** The app repo's root. */
  cwd: string;
  /** Put the template's `marketing/` folder somewhere and return its path (default: shallow clone of template-app). */
  fetchTemplate?: (workDir: string) => Promise<string>;
  /** The app's public listing, or null (default: GET /v1/storefront/apps/:id). */
  fetchListing?: (appId: string) => Promise<MarketingListing | null>;
}

export interface AddMarketingResult {
  appId: string;
  added: string[];
  skipped: string[];
  scripts: string[];
  prefilled: string[];
  deployPublishes: boolean;
}

const TEXT_EXTENSIONS = new Set(['.ts', '.astro', '.json', '.css', '.md', '.mjs', '.js', '.html', '.txt', '.xml', '.svg']);
const SCRIPTS: Record<string, string> = {
  'dev:marketing': 'pnpm --dir marketing --ignore-workspace dev',
  'build:marketing': 'pnpm --dir marketing --ignore-workspace build',
};
const APP_ID_RE = /^[a-z][a-z0-9-]{0,56}$/;

async function cloneTemplate(workDir: string): Promise<string> {
  const template = await resolveTemplate(undefined);
  const dest = join(workDir, 'template');
  await run('git', ['clone', '--quiet', '--depth=1', '--branch', template.ref, `https://github.com/${template.repo}.git`, dest]);
  return join(dest, 'marketing');
}

async function publicListing(appId: string): Promise<MarketingListing | null> {
  try {
    const { apiBase } = await readConfig();
    const res = await fetch(`${apiBase}/v1/storefront/apps/${appId}`, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as MarketingListing) : null;
  } catch {
    return null; // offline, private (404) or unlisted: the template's defaults stay
  }
}

/** The app id: `.pas.json` `appId`, else the root package.json `name` (scope stripped). */
export function detectAppId(cwd: string): string | null {
  const pas = readJsonIfExists<{ appId?: unknown }>(join(cwd, '.pas.json'));
  if (typeof pas?.appId === 'string' && APP_ID_RE.test(pas.appId)) return pas.appId;
  const pkg = readJsonIfExists<{ name?: unknown }>(join(cwd, 'package.json'));
  const name = typeof pkg?.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '').replace(/\/.*$/, '') : '';
  return APP_ID_RE.test(name) && !name.startsWith('about-') ? name : null;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.astro') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function hex(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

/** Mix a #rrggbb colour toward `target` (0 = unchanged, 1 = target). */
function mix(color: string, target: number, amount: number): string {
  const c = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return '#' + c.map((v) => Math.round(v + (target - v) * amount).toString(16).padStart(2, '0')).join('');
}

/** Replace `key: <literal>` in site.ts; returns whether it matched. */
function setField(src: { text: string }, key: string, value: string): boolean {
  const re = new RegExp(`(\\n\\s*${key}: )(?:'[^'\\n]*'|"[^"\\n]*")`);
  if (!re.test(src.text)) return false;
  src.text = src.text.replace(re, `$1${JSON.stringify(value)}`);
  return true;
}

/** site.ts with the app's name and, when the public listing has them, its tagline, support link and brand colour. */
export function prefillSite(text: string, appId: string, listing: MarketingListing | null): { text: string; prefilled: string[] } {
  const name = toTitleCase(appId);
  const src = { text };
  const prefilled: string[] = [];
  if (setField(src, 'name', name)) prefilled.push('name');
  if (setField(src, 'headline', `Explore ${name}.`)) prefilled.push('headline');
  if (setField(src, 'ctaLabel', `Open ${name}`)) prefilled.push('ctaLabel');
  if (setField(src, 'owner', `The ${name} team`)) prefilled.push('owner');
  const summary = (listing?.tagline || listing?.longDescription || '').trim().slice(0, 300);
  if (summary && setField(src, 'summary', summary)) prefilled.push('summary');
  const support = typeof listing?.supportUrl === 'string' && /^https:\/\//.test(listing.supportUrl) ? listing.supportUrl : null;
  if (support && setField(src, 'supportUrl', support)) prefilled.push('supportUrl');
  const accent = hex(listing?.themeColor);
  if (accent) {
    const ok = setField(src, 'accent', accent)
      && setField(src, 'accentDeep', mix(accent, 0, 0.35))
      && setField(src, 'accentSoft', mix(accent, 255, 0.7));
    if (ok) prefilled.push('colors');
  }
  return { text: src.text, prefilled };
}

export async function addMarketing(opts: AddMarketingOptions): Promise<AddMarketingResult> {
  const cwd = resolve(opts.cwd);
  const appId = detectAppId(cwd);
  if (!appId) throw new Error('Not an app repo: run this from the app root (needs .pas.json with appId, or a package.json name that is a valid app id).');

  const workDir = await mkdtemp(join(tmpdir(), 'pas-marketing-'));
  const result: AddMarketingResult = { appId, added: [], skipped: [], scripts: [], prefilled: [], deployPublishes: false };
  try {
    const source = await (opts.fetchTemplate ?? cloneTemplate)(workDir);
    for await (const file of walk(source)) {
      const rel = join('marketing', relative(source, file));
      const target = join(cwd, rel);
      if (await exists(target)) { result.skipped.push(rel); continue; }
      await mkdir(dirname(target), { recursive: true });
      if (TEXT_EXTENSIONS.has(extname(file).toLowerCase())) {
        let text = (await readFile(file, 'utf8')).split('APPNAME').join(appId);
        if (rel === join('marketing', 'src', 'site.ts')) {
          const filled = prefillSite(text, appId, await (opts.fetchListing ?? publicListing)(appId));
          text = filled.text;
          result.prefilled = filled.prefilled;
        }
        await writeFile(target, text);
      } else {
        await copyFile(file, target);
      }
      result.added.push(rel);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  // Root scripts, only where absent. pnpm-workspace.yaml is deliberately left alone.
  const pkgPath = join(cwd, 'package.json');
  const pkg = readJsonIfExists<{ scripts?: Record<string, string> } & Record<string, unknown>>(pkgPath);
  if (pkg) {
    const scripts = { ...(pkg.scripts ?? {}) };
    for (const [key, value] of Object.entries(SCRIPTS)) {
      if (scripts[key] === undefined) { scripts[key] = value; result.scripts.push(key); }
    }
    if (result.scripts.length) await writeFile(pkgPath, JSON.stringify({ ...pkg, scripts }, null, 2) + '\n');
  }

  const deploy = await readFile(join(cwd, '.github', 'workflows', 'deploy.yml'), 'utf8').catch(() => '');
  result.deployPublishes = deploy.includes('Publish marketing site');
  return result;
}

export const marketingCommand = new Command('marketing')
  .description('The app\'s marketing site at https://about-<app>.proappstore.online/.');

marketingCommand
  .command('add')
  .description('Add the Astro marketing site (home, Privacy, Terms, contact form) to this app repo. Never overwrites existing files.')
  .action(async () => {
    try {
      const r = await addMarketing({ cwd: process.cwd() });
      const out = (s: string) => process.stdout.write(s + '\n');
      out(`Marketing site for ${r.appId}:`);
      for (const f of r.added) out(`  + ${f}`);
      for (const f of r.skipped) out(`  = ${f} (exists, left as is)`);
      for (const s of r.scripts) out(`  + package.json script ${s}`);
      out(`\n${r.added.length} file(s) added, ${r.skipped.length} skipped, ${r.scripts.length} script(s) added.`);
      if (r.prefilled.length) out(`Pre-filled in marketing/src/site.ts: ${r.prefilled.join(', ')}. Review the copy there before you publish.`);
      out('\nNext:');
      out('  pnpm --dir marketing install --ignore-workspace   # once');
      out('  pnpm dev:marketing                                # preview');
      out('  commit marketing/ and push to main');
      if (r.deployPublishes) {
        out(`The deploy then publishes it to https://about-${r.appId}.proappstore.online/`);
      } else {
        out(`\nNote: .github/workflows/deploy.yml has no "Publish marketing site" step, so a push will not publish it yet.`);
        out('Update the workflow to the current canonical one (proappstore-online/template-app .github/workflows/deploy.yml).');
      }
    } catch (e) {
      process.stderr.write(`pas marketing add: ${(e as Error).message}\n`);
      process.exitCode = 1;
    }
  });
