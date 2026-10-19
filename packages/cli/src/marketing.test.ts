import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMarketing, detectAppId, prefillSite } from './marketing.js';

// #410: `pas marketing add` copies template-app's marketing/ into an existing
// app repo, never overwriting, pre-filled from the app id and public listing.

/** The shape of template-app's marketing/src/site.ts (#407), trimmed. */
const SITE_TS = `export const site = {
  appId: 'APPNAME',
  name: 'APPNAME',
  appUrl: 'https://APPNAME.proappstore.online/',
  owner: 'The APPNAME team',
  supportUrl: '',
  colors: {
    accent: '#d86f4d',
    accentDeep: '#9f4427',
    accentSoft: '#ffd4bf',
  },
  headline: 'Explore APPNAME.',
  summary: 'Describe in one or two sentences what APPNAME does and who it is for.',
  ctaLabel: 'Open APPNAME',
}
`;
const ICON = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);

let root: string;
let template: string;
let app: string;

/** A fake template-app checkout: what cloneTemplate would return. */
function makeTemplate(): string {
  const dir = join(root, 'template', 'marketing');
  mkdirSync(join(dir, 'src', 'pages'), { recursive: true });
  mkdirSync(join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'astro'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@APPNAME/marketing', scripts: { build: 'astro build' } }));
  writeFileSync(join(dir, 'src', 'site.ts'), SITE_TS);
  writeFileSync(join(dir, 'src', 'pages', 'index.astro'), '<h1>{site.name}</h1>');
  writeFileSync(join(dir, 'src', 'pages', 'privacy.astro'), '<h1>Privacy</h1>');
  writeFileSync(join(dir, 'public', 'icon-192.png'), ICON);
  writeFileSync(join(dir, 'node_modules', 'astro', 'x.js'), 'never copied');
  return dir;
}
const fetchTemplate = async () => template;
const noListing = async () => null;
const read = (p: string) => readFileSync(join(app, p), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pas-marketing-test-'));
  template = makeTemplate();
  app = join(root, 'app');
  mkdirSync(app);
  writeFileSync(join(app, '.pas.json'), JSON.stringify({ appId: 'kanban-pro' }));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@kanban-pro/root', private: true, scripts: { build: 'pnpm --filter web build' } }, null, 2) + '\n');
  writeFileSync(join(app, 'pnpm-workspace.yaml'), 'packages:\n  - web\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pas marketing add (#410)', () => {
  it('copies the template into an app without a marketing folder, with the app id in place of APPNAME', async () => {
    const r = await addMarketing({ cwd: app, fetchTemplate, fetchListing: noListing });
    expect(r.appId).toBe('kanban-pro');
    expect(r.added.sort()).toEqual([
      'marketing/package.json', 'marketing/public/icon-192.png', 'marketing/src/pages/index.astro', 'marketing/src/pages/privacy.astro', 'marketing/src/site.ts',
    ]);
    expect(r.skipped).toEqual([]);
    expect(JSON.parse(read('marketing/package.json')).name).toBe('@kanban-pro/marketing');
    expect(readFileSync(join(app, 'marketing/public/icon-192.png'))).toEqual(ICON); // binary copied byte for byte
    const site = read('marketing/src/site.ts');
    expect(site).toContain(`appId: 'kanban-pro'`);
    expect(site).toContain('name: "Kanban Pro"');
    expect(site).toContain('headline: "Explore Kanban Pro."');
    expect(site).not.toContain('APPNAME');
    // Never node_modules, and the workspace is left alone.
    expect(() => read('marketing/node_modules/astro/x.js')).toThrow();
    expect(read('pnpm-workspace.yaml')).toBe('packages:\n  - web\n');
  });

  it('never overwrites an existing file', async () => {
    mkdirSync(join(app, 'marketing', 'src'), { recursive: true });
    writeFileSync(join(app, 'marketing', 'src', 'site.ts'), 'export const site = { mine: true }\n');
    writeFileSync(join(app, 'marketing', 'package.json'), '{"name":"mine"}');
    const r = await addMarketing({ cwd: app, fetchTemplate, fetchListing: async () => ({ tagline: 'Never applied' }) });
    expect(r.skipped.sort()).toEqual(['marketing/package.json', 'marketing/src/site.ts']);
    expect(r.added).toContain('marketing/src/pages/index.astro');
    expect(read('marketing/src/site.ts')).toBe('export const site = { mine: true }\n');
    expect(read('marketing/package.json')).toBe('{"name":"mine"}');
    expect(r.prefilled).toEqual([]);
    // A second run adds nothing.
    const again = await addMarketing({ cwd: app, fetchTemplate, fetchListing: noListing });
    expect(again.added).toEqual([]);
  });

  it('adds the root scripts only when absent, keeping the rest of package.json', async () => {
    const first = await addMarketing({ cwd: app, fetchTemplate, fetchListing: noListing });
    expect(first.scripts).toEqual(['dev:marketing', 'build:marketing']);
    const pkg = JSON.parse(read('package.json'));
    expect(pkg).toMatchObject({ name: '@kanban-pro/root', private: true });
    expect(pkg.scripts).toEqual({
      build: 'pnpm --filter web build',
      'dev:marketing': 'pnpm --dir marketing --ignore-workspace dev',
      'build:marketing': 'pnpm --dir marketing --ignore-workspace build',
    });

    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'dev:marketing': 'my own' } }));
    rmSync(join(app, 'marketing'), { recursive: true });
    const second = await addMarketing({ cwd: app, fetchTemplate, fetchListing: noListing });
    expect(second.scripts).toEqual(['build:marketing']);
    expect(JSON.parse(read('package.json')).scripts['dev:marketing']).toBe('my own');
  });

  it('without .pas.json uses the package.json name; with neither it refuses and writes nothing', async () => {
    rmSync(join(app, '.pas.json'));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'notes' }));
    expect((await addMarketing({ cwd: app, fetchTemplate, fetchListing: noListing })).appId).toBe('notes');

    const bare = join(root, 'bare');
    mkdirSync(bare);
    await expect(addMarketing({ cwd: bare, fetchTemplate, fetchListing: noListing })).rejects.toThrow(/Not an app repo/);
    writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'about-x' }));
    await expect(addMarketing({ cwd: bare, fetchTemplate, fetchListing: noListing })).rejects.toThrow(/Not an app repo/);
    expect(() => readFileSync(join(bare, 'marketing', 'src', 'site.ts'))).toThrow();
  });

  it('reports whether the app deploy workflow already publishes marketing', async () => {
    expect((await addMarketing({ cwd: app, fetchTemplate, fetchListing: noListing })).deployPublishes).toBe(false);
    mkdirSync(join(app, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(app, '.github', 'workflows', 'deploy.yml'), '      - name: Publish marketing site (marketing/ -> about-<app>, keyless)\n');
    expect((await addMarketing({ cwd: app, fetchTemplate, fetchListing: noListing })).deployPublishes).toBe(true);
  });
});

describe('prefillSite (#410)', () => {
  const site = SITE_TS.split('APPNAME').join('shop');

  it('fills tagline, an https support link and the brand colour from the public listing', () => {
    const r = prefillSite(site, 'shop', { tagline: "Shop's best: \"fast\" checkout", supportUrl: 'https://help.example/shop', themeColor: '#336699' });
    expect(r.prefilled).toEqual(['name', 'headline', 'ctaLabel', 'owner', 'summary', 'supportUrl', 'colors']);
    expect(r.text).toContain('summary: "Shop\'s best: \\"fast\\" checkout"');
    expect(r.text).toContain('supportUrl: "https://help.example/shop"');
    expect(r.text).toContain('accent: "#336699"');
    expect(r.text).toMatch(/accentDeep: "#[0-9a-f]{6}"/);
    expect(r.text).toMatch(/accentSoft: "#[0-9a-f]{6}"/);
    expect(r.text).not.toContain('#d86f4d');
  });

  it('keeps the template defaults when the listing has nothing usable', () => {
    const r = prefillSite(site, 'shop', { tagline: '  ', supportUrl: 'javascript:alert(1)', themeColor: 'red' });
    expect(r.prefilled).toEqual(['name', 'headline', 'ctaLabel', 'owner']);
    expect(r.text).toContain("supportUrl: ''");
    expect(r.text).toContain("accent: '#d86f4d'");
    expect(prefillSite(site, 'shop', null).prefilled).toEqual(['name', 'headline', 'ctaLabel', 'owner']);
  });

  it('detectAppId ignores an invalid .pas.json appId and strips a package scope', () => {
    writeFileSync(join(app, '.pas.json'), JSON.stringify({ appId: 'Bad Id' }));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@scope/inventory' }));
    expect(detectAppId(app)).toBe('inventory');
  });
});
