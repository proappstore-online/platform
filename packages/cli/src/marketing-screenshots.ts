import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `pas marketing screenshots` (#590): capture routes of a running app as the
 * marketing site's hero image and screenshots. Screenshots are published on a
 * public site, so the app should run on its own demo/mock fixtures: a fresh
 * browser context never carries a real session, and a URL that is not local
 * needs an explicit `--allow-remote`.
 *
 * Playwright is not a CLI dependency (it is ~100 MB with its browser); it is
 * resolved from the app's own install, where its e2e tests already put it.
 */

export const VIEWPORT = { width: 1200, height: 900 } as const; // 4:3, the hero's 640x480 slot at ~2x
const WEBP_QUALITY = 0.82; // cwebp -q 82
const PLAYWRIGHT_PACKAGES = ['playwright', '@playwright/test', 'playwright-core'];
/** Where an app keeps its Playwright install, relative to its root. */
const PLAYWRIGHT_DIRS = ['.', 'e2e', 'web'];

/** The slice of Playwright's API this uses; structural, so the CLI needs no Playwright types. */
export interface ShotPage {
  goto(url: string, opts: { waitUntil: 'networkidle' }): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  screenshot(opts: { type: 'png'; animations: 'disabled' }): Promise<Buffer>;
}
interface ShotContext {
  newPage(): Promise<ShotPage>;
  close(): Promise<void>;
}
interface ShotBrowser {
  newContext(opts: { viewport: { width: number; height: number }; serviceWorkers: 'block' }): Promise<ShotContext>;
  close(): Promise<void>;
}
export interface Chromium {
  launch(): Promise<ShotBrowser>;
}
/** A `--setup` module's default export: prepares each fresh context (e.g. mocks the platform) before its route loads. */
type ScreenshotSetup = (context: ShotContext, info: { route: string; url: string }) => Promise<unknown> | unknown;

export interface ShotRoute {
  /** File name without extension, e.g. `mower-streets`. */
  slug: string;
  /** Path (with query/hash) appended to the base URL, e.g. `/mower/streets`. */
  route: string;
}

export interface ScreenshotOptions {
  cwd: string;
  url: string;
  routes: ShotRoute[];
  format: 'webp' | 'png';
  /** Module path (relative to cwd) whose default export is a ScreenshotSetup. */
  setup?: string | undefined;
  allowRemote?: boolean | undefined;
  /** Default: Playwright's chromium resolved from the app's install. */
  loadChromium?: (cwd: string) => Promise<Chromium>;
}

export interface ScreenshotResult {
  files: { slug: string; route: string; path: string; src: string; format: 'webp' | 'png' }[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `/a,/b` or `name=/a,…` → routes with unique file slugs. */
export function parseRoutes(value: string): ShotRoute[] {
  const routes = value.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const eq = entry.startsWith('/') ? -1 : entry.indexOf('=');
    const route = eq === -1 ? entry : entry.slice(eq + 1).trim();
    const slug = eq === -1 ? routeSlug(route) : entry.slice(0, eq).trim();
    if (!route.startsWith('/')) throw new Error(`Route "${route}" must start with "/".`);
    if (!SLUG_RE.test(slug)) throw new Error(`Screenshot name "${slug}" must be lowercase letters, digits and hyphens.`);
    return { slug, route };
  });
  if (!routes.length) throw new Error('Give at least one route, e.g. --routes /,/settings');
  const seen = new Set<string>();
  for (const r of routes) {
    if (seen.has(r.slug)) throw new Error(`Two routes would both be saved as "${r.slug}"; name one: --routes name=/path`);
    seen.add(r.slug);
  }
  return routes;
}

/** `/mower/streets?x=1` → `mower-streets`; `/` → `home`. */
export function routeSlug(route: string): string {
  const path = route.replace(/[?#].*$/, '');
  return path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'home';
}

export function isLocalUrl(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
}

/** The `heroImage` / `screenshots` entries for marketing/src/site.ts: the first file is the hero. */
export function siteSnippet(files: ScreenshotResult['files']): string {
  const entry = (f: ScreenshotResult['files'][number]) => `{ src: '${f.src}', alt: 'TODO: describe ${f.route} (demo data)' }`;
  const [hero, ...rest] = files;
  if (!hero) return '';
  return [
    `  heroImage: ${entry(hero)} as Image | null,`,
    '  screenshots: [',
    ...rest.map((f) => `    ${entry(f)},`),
    '  ] as Image[],',
  ].join('\n');
}

/** Playwright's chromium from the app's own install (root, e2e/ or web/); never one found outside the app via NODE_PATH. */
export async function loadAppChromium(cwd: string): Promise<Chromium> {
  const root = realpathSync(cwd) + sep;
  for (const dir of PLAYWRIGHT_DIRS) {
    const pkgJson = join(cwd, dir, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const req = createRequire(pkgJson);
    for (const name of PLAYWRIGHT_PACKAGES) {
      let path: string;
      try { path = realpathSync(req.resolve(name)); } catch { continue; }
      if (!path.startsWith(root)) continue;
      const mod = await import(pathToFileURL(path).href) as { chromium?: Chromium; default?: { chromium?: Chromium } };
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return chromium;
    }
  }
  throw new Error(
    'Playwright not found in this app (looked in ./, e2e/ and web/). Install it where your e2e tests live, e.g.\n'
    + '  pnpm add -D playwright && pnpm exec playwright install chromium',
  );
}

async function loadSetup(cwd: string, file: string): Promise<ScreenshotSetup> {
  const mod = await import(pathToFileURL(resolve(cwd, file)).href) as { default?: unknown; setup?: unknown };
  const fn = mod.default ?? mod.setup;
  if (typeof fn !== 'function') throw new Error(`${file} must export a default function (context, { route, url }) that prepares the browser context.`);
  return fn as ScreenshotSetup;
}

/** The browser globals the page functions below use; the CLI compiles without the DOM lib. */
interface BrowserGlobals {
  document: {
    fonts: { ready: Promise<unknown> };
    createElement(tag: 'canvas'): { width: number; height: number; getContext(type: '2d'): { drawImage(img: unknown, x: number, y: number): void } | null; toDataURL(type: string, quality: number): string };
  };
  createImageBitmap(blob: Blob): Promise<{ width: number; height: number }>;
}

/** PNG → WebP with Chromium's own encoder (no cwebp needed); null when this browser cannot encode WebP. */
async function toWebp(page: ShotPage, png: Buffer): Promise<Buffer | null> {
  const dataUrl = await page.evaluate(async ({ b64, quality }) => {
    const { document, createImageBitmap } = globalThis as unknown as BrowserGlobals;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    return canvas.toDataURL('image/webp', quality);
  }, { b64: png.toString('base64'), quality: WEBP_QUALITY });
  const prefix = 'data:image/webp;base64,';
  return dataUrl.startsWith(prefix) ? Buffer.from(dataUrl.slice(prefix.length), 'base64') : null;
}

export async function captureScreenshots(opts: ScreenshotOptions): Promise<ScreenshotResult> {
  const cwd = resolve(opts.cwd);
  const base = new URL(opts.url);
  if (!/^https?:$/.test(base.protocol)) throw new Error(`--url must be http(s): ${opts.url}`);
  if (!isLocalUrl(opts.url) && !opts.allowRemote) {
    throw new Error(
      `${base.origin} is not local. Screenshots are public: capture a local preview running on demo/mock data, `
      + 'or pass --allow-remote if you are sure this URL shows nothing private.',
    );
  }
  if (!existsSync(join(cwd, 'marketing'))) throw new Error('No marketing/ folder here: run this from the app root (add one with `pas marketing add`).');
  const outDir = join(cwd, 'marketing', 'public', 'assets');
  const setup = opts.setup ? await loadSetup(cwd, opts.setup) : null;
  const chromium = await (opts.loadChromium ?? loadAppChromium)(cwd);

  const result: ScreenshotResult = { files: [] };
  const browser = await chromium.launch();
  try {
    await mkdir(outDir, { recursive: true });
    for (const { slug, route } of opts.routes) {
      const url = new URL(route.replace(/^\/+/, ''), base.href.endsWith('/') ? base.href : `${base.href}/`).href;
      // A fresh context per route: no cookies or storage carried over, service workers blocked so a cached build is never shot.
      const context = await browser.newContext({ viewport: { ...VIEWPORT }, serviceWorkers: 'block' });
      try {
        if (setup) await setup(context, { route, url });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'networkidle' });
        await page.evaluate(() => (globalThis as unknown as BrowserGlobals).document.fonts.ready.then(() => undefined), undefined);
        const png = await page.screenshot({ type: 'png', animations: 'disabled' });
        const webp = opts.format === 'webp' ? await toWebp(page, png) : null;
        const format = webp ? 'webp' : 'png';
        const path = join(outDir, `${slug}.${format}`);
        await writeFile(path, webp ?? png);
        result.files.push({ slug, route, path, src: `/assets/${slug}.${format}`, format });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return result;
}
