import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureScreenshots, isLocalUrl, loadAppChromium, parseRoutes, routeSlug, siteSnippet,
  type Chromium, type ShotPage,
} from './marketing-screenshots.js';

// #590: `pas marketing screenshots` shoots routes of a running app into
// marketing/public/assets/ and prints the site.ts entries for them.

const PNG = Buffer.from('png-bytes');
const WEBP = Buffer.from('webp-bytes');

let app: string;
beforeEach(() => {
  app = mkdtempSync(join(tmpdir(), 'pas-shots-test-'));
  mkdirSync(join(app, 'marketing'));
});
afterEach(() => rmSync(app, { recursive: true, force: true }));

/** A stand-in for Playwright's chromium that records what the command asked of it. */
function fakeChromium({ webp = true } = {}) {
  const log: string[] = [];
  const contexts: unknown[] = [];
  const chromium: Chromium = {
    async launch() {
      log.push('launch');
      return {
        async newContext(opts) {
          contexts.push(opts);
          const context = {
            async newPage(): Promise<ShotPage> {
              return {
                async goto(url) { log.push(`goto ${url}`); },
                async evaluate(_fn, arg) {
                  // The second evaluate is the WebP encode (it gets the PNG as base64).
                  const encode = (arg as { b64?: string } | undefined)?.b64;
                  if (!encode) return undefined as never;
                  expect(Buffer.from(encode, 'base64')).toEqual(PNG);
                  return (webp ? `data:image/webp;base64,${WEBP.toString('base64')}` : 'data:image/png;base64,') as never;
                },
                async screenshot(o) { log.push(`shot ${o.type}`); return PNG; },
              };
            },
            async close() { log.push('close context'); },
          };
          return context;
        },
        async close() { log.push('close browser'); },
      };
    },
  };
  return { chromium, log, contexts, loadChromium: async () => chromium };
}

describe('parseRoutes / routeSlug', () => {
  it('derives file names from routes, or takes a given name', () => {
    expect(parseRoutes('/, /mower/streets?tab=open ,dash=/mower')).toEqual([
      { slug: 'home', route: '/' },
      { slug: 'mower-streets', route: '/mower/streets?tab=open' },
      { slug: 'dash', route: '/mower' },
    ]);
    expect(routeSlug('/Groups/42#x')).toBe('groups-42');
  });

  it('rejects relative routes, bad names, clashes and an empty list', () => {
    expect(() => parseRoutes('settings')).toThrow(/must start with/);
    expect(() => parseRoutes('My Shot=/a')).toThrow(/lowercase/);
    expect(() => parseRoutes('/a-b,/a/b')).toThrow(/both be saved as "a-b"/);
    expect(() => parseRoutes(' , ')).toThrow(/at least one route/);
  });
});

describe('isLocalUrl', () => {
  it('accepts only loopback hosts', () => {
    for (const u of ['http://localhost:4173', 'http://127.0.0.1:5173/x', 'http://[::1]:4173', 'http://app.localhost']) expect(isLocalUrl(u)).toBe(true);
    for (const u of ['https://grasskarma.proappstore.online', 'http://192.168.1.4:4173']) expect(isLocalUrl(u)).toBe(false);
  });
});

describe('siteSnippet', () => {
  it('makes the first file the hero and the rest screenshots', () => {
    const files = [
      { slug: 'home', route: '/', path: '', src: '/assets/home.webp', format: 'webp' as const },
      { slug: 'dash', route: '/mower', path: '', src: '/assets/dash.webp', format: 'webp' as const },
    ];
    expect(siteSnippet(files)).toBe([
      "  heroImage: { src: '/assets/home.webp', alt: 'TODO: describe / (demo data)' } as Image | null,",
      '  screenshots: [',
      "    { src: '/assets/dash.webp', alt: 'TODO: describe /mower (demo data)' },",
      '  ] as Image[],',
    ].join('\n'));
  });
});

describe('captureScreenshots', () => {
  it('shoots each route in a fresh 1200x900 context with service workers blocked and writes webp', async () => {
    const fake = fakeChromium();
    const r = await captureScreenshots({
      cwd: app, url: 'http://localhost:4173/base', routes: parseRoutes('/,dash=/mower?x=1'), format: 'webp', loadChromium: fake.loadChromium,
    });
    expect(fake.contexts).toEqual([
      { viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' },
      { viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' },
    ]);
    expect(fake.log).toEqual([
      'launch',
      'goto http://localhost:4173/base/', 'shot png', 'close context',
      'goto http://localhost:4173/base/mower?x=1', 'shot png', 'close context',
      'close browser',
    ]);
    expect(r.files.map((f) => f.src)).toEqual(['/assets/home.webp', '/assets/dash.webp']);
    expect(readFileSync(join(app, 'marketing/public/assets/dash.webp'))).toEqual(WEBP);
  });

  it('writes png when asked, or when the browser cannot encode webp', async () => {
    const asked = await captureScreenshots({ cwd: app, url: 'http://localhost:4173', routes: parseRoutes('/'), format: 'png', loadChromium: fakeChromium().loadChromium });
    expect(asked.files[0]).toMatchObject({ src: '/assets/home.png', format: 'png' });
    const fallback = await captureScreenshots({ cwd: app, url: 'http://localhost:4173', routes: parseRoutes('/a'), format: 'webp', loadChromium: fakeChromium({ webp: false }).loadChromium });
    expect(fallback.files[0]).toMatchObject({ src: '/assets/a.png', format: 'png' });
    expect(readFileSync(join(app, 'marketing/public/assets/a.png'))).toEqual(PNG);
  });

  it('runs the --setup module on each context before its route loads', async () => {
    writeFileSync(join(app, 'shots.setup.mjs'), `export default (context, info) => { (globalThis.__shotSetup ??= []).push(info.url); };`);
    const fake = fakeChromium();
    await captureScreenshots({ cwd: app, url: 'http://localhost:4173', routes: parseRoutes('/a,/b'), format: 'webp', setup: 'shots.setup.mjs', loadChromium: fake.loadChromium });
    expect((globalThis as { __shotSetup?: string[] }).__shotSetup).toEqual(['http://localhost:4173/a', 'http://localhost:4173/b']);
  });

  it('refuses a non-local URL without --allow-remote, and never launches a browser for it', async () => {
    const fake = fakeChromium();
    await expect(captureScreenshots({ cwd: app, url: 'https://grasskarma.proappstore.online', routes: parseRoutes('/'), format: 'webp', loadChromium: fake.loadChromium }))
      .rejects.toThrow(/not local.*--allow-remote/);
    expect(fake.log).toEqual([]);
    await captureScreenshots({ cwd: app, url: 'https://grasskarma.proappstore.online', routes: parseRoutes('/'), format: 'webp', allowRemote: true, loadChromium: fake.loadChromium });
    expect(fake.log).toContain('goto https://grasskarma.proappstore.online/');
  });

  it('needs a marketing/ folder and a setup module with a default function', async () => {
    rmSync(join(app, 'marketing'), { recursive: true });
    await expect(captureScreenshots({ cwd: app, url: 'http://localhost:4173', routes: parseRoutes('/'), format: 'webp', loadChromium: fakeChromium().loadChromium }))
      .rejects.toThrow(/pas marketing add/);
    mkdirSync(join(app, 'marketing'));
    writeFileSync(join(app, 'bad.mjs'), 'export const x = 1;');
    await expect(captureScreenshots({ cwd: app, url: 'http://localhost:4173', routes: parseRoutes('/'), format: 'webp', setup: 'bad.mjs', loadChromium: fakeChromium().loadChromium }))
      .rejects.toThrow(/default function/);
  });
});

describe('loadAppChromium', () => {
  it('explains how to install Playwright when the app has none', async () => {
    writeFileSync(join(app, 'package.json'), '{"name":"x"}');
    await expect(loadAppChromium(app)).rejects.toThrow(/Playwright not found.*\n.*playwright install chromium/);
  });
});
