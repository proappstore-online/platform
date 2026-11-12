import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMarketing, detectAppId, prefillSite, deployPublishesMarketing, manifestAppName } from './marketing.js';

// #410: `pas marketing add` copies template-app's marketing/ into an existing
// app repo, never overwriting, pre-filled from the app id and public listing.

/** The shape of template-app's marketing/src/site.ts (#407), trimmed. */
const SITE_TS = `export const site = {
  appId: 'APPNAME',
  name: 'APPNAME',
  appUrl: 'https://APPNAME.proappstore.online/',
  owner: 'The APPNAME team',
  supportUrl: '',
  legalUpdated: '2026-10-18',
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
const LAYOUT = '<link rel="icon" href="/icon-192.png?v=neutral-1" />\n<img src="/icon-192.png?v=neutral-1" />\n';
const GITIGNORE = '.astro/\ndist/\nnode_modules/\n';
const today = () => new Date().toISOString().slice(0, 10);

let root: string;
let template: string;
let app: string;

/** A fake template-app checkout: what cloneTemplate would return. */
function makeTemplate(): string {
  const dir = join(root, 'template', 'marketing');
  mkdirSync(join(dir, 'src', 'pages'), { recursive: true });
  mkdirSync(join(dir, 'src', 'layouts'), { recursive: true });
  mkdirSync(join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'astro'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@APPNAME/marketing', scripts: { build: 'astro build' } }));
  writeFileSync(join(dir, 'src', 'site.ts'), SITE_TS);
  writeFileSync(join(dir, 'src', 'pages', 'index.astro'), '<h1>{site.name}</h1>');
  writeFileSync(join(dir, 'src', 'pages', 'privacy.astro'), '<h1>Privacy</h1>');
  writeFileSync(join(dir, 'public', 'icon-192.png'), ICON);
  writeFileSync(join(dir, 'src', 'layouts', 'Layout.astro'), LAYOUT);
  writeFileSync(join(dir, '.gitignore'), GITIGNORE);
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
      'marketing/.gitignore', 'marketing/package.json', 'marketing/src/layouts/Layout.astro', 'marketing/public/icon-192.png', 'marketing/src/pages/index.astro', 'marketing/src/pages/privacy.astro', 'marketing/src/site.ts',
    ].map(path => join(...path.split('/'))).sort());
    expect(r.skipped).toEqual([]);
    expect(JSON.parse(read('marketing/package.json')).name).toBe('@kanban-pro/marketing');
    expect(readFileSync(join(app, 'marketing/public/icon-192.png'))).toEqual(ICON); // binary copied byte for byte
    const site = read('marketing/src/site.ts');
    expect(site).toContain(`appId: 'kanban-pro'`);
    expect(site).toContain('name: "Kanban Pro"');
    expect(site).toContain('headline: "Explore Kanban Pro."');
    expect(site).toContain(`legalUpdated: "${today()}"`);
    expect(site).not.toContain('APPNAME');
    expect(read('marketing/.gitignore')).toBe(GITIGNORE);
    expect(read('marketing/src/layouts/Layout.astro')).toBe(LAYOUT); // no app icon: the template's stays, cache key too
    expect(r.icons).toEqual([]);
    // Never node_modules, and the workspace is left alone.
    expect(() => read('marketing/node_modules/astro/x.js')).toThrow();
    expect(read('pnpm-workspace.yaml')).toBe('packages:\n  - web\n');
  });

  // #589: the app's display name and icons, not the capitalised id and the template's.
  it("takes the name from the app's PWA manifest and copies its own icons, busting the icon cache key", async () => {
    mkdirSync(join(app, 'web', 'public'), { recursive: true });
    writeFileSync(join(app, 'web', 'vite.config.ts'), "VitePWA({\n  manifest: {\n    name: 'GrassKarma',\n    short_name: 'GK',\n  },\n})\n");
    const own192 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    writeFileSync(join(app, 'web', 'public', 'icon-192.png'), own192);
    const r = await addMarketing({ cwd: app, fetchTemplate, fetchListing: noListing });
    const site = read('marketing/src/site.ts');
    expect(site).toContain('name: "GrassKarma"');
    expect(site).toContain('owner: "The GrassKarma team"');
    expect(readFileSync(join(app, 'marketing/public/icon-192.png'))).toEqual(own192);
    expect(r.icons).toEqual([join('marketing', 'public', 'icon-192.png')]);
    const layout = read('marketing/src/layouts/Layout.astro');
    expect(layout).not.toContain('neutral-1');
    expect(layout.match(/icon-192\.png\?v=app-[0-9a-f]{8}/g)).toHaveLength(2);
  });

  it("keeps the template's icon when the app still ships a template default", async () => {
    mkdirSync(join(app, 'web', 'public'), { recursive: true });
    writeFileSync(join(app, 'web', 'public', 'icon-192.png'), readFileSync(new URL('../../compliance/src/__fixtures__/template-icons/f-192.png', import.meta.url)));
    const r = await addMarketing({ cwd: app, fetchTemplate, fetchListing: noListing });
    expect(r.icons).toEqual([]);
    expect(readFileSync(join(app, 'marketing/public/icon-192.png'))).toEqual(ICON);
  });

  it('never overwrites an existing file', async () => {
    mkdirSync(join(app, 'marketing', 'src'), { recursive: true });
    writeFileSync(join(app, 'marketing', 'src', 'site.ts'), 'export const site = { mine: true }\n');
    writeFileSync(join(app, 'marketing', 'package.json'), '{"name":"mine"}');
    const r = await addMarketing({ cwd: app, fetchTemplate, fetchListing: async () => ({ tagline: 'Never applied' }) });
    expect(r.skipped.sort()).toEqual([join('marketing', 'package.json'), join('marketing', 'src', 'site.ts')].sort());
    expect(r.added).toContain(join('marketing', 'src', 'pages', 'index.astro'));
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

  // #427: a caller of the reusable pipeline publishes unless it opts out.
  it('a caller of the reusable deploy pipeline publishes marketing unless it sets marketing: false', () => {
    const caller = 'jobs:\n  deploy:\n    uses: proappstore-online/platform/.github/workflows/app-deploy.yml@app-deploy-v1\n    secrets: inherit\n';
    expect(deployPublishesMarketing(caller)).toBe(true);
    expect(deployPublishesMarketing(`# with:\n#   marketing: false\n${caller}`)).toBe(true); // a comment is not an input
    expect(deployPublishesMarketing(caller.replace('    secrets: inherit', '    with:\n      marketing: false\n    secrets: inherit'))).toBe(false);
    expect(deployPublishesMarketing(caller.replace('    secrets: inherit', "    with:\n      marketing: 'false'\n    secrets: inherit"))).toBe(false);
    expect(deployPublishesMarketing('jobs:\n  deploy:\n    uses: someone-else/x/.github/workflows/app-deploy.yml@v1\n')).toBe(false);
  });
});

describe('prefillSite (#410)', () => {
  const site = SITE_TS.split('APPNAME').join('shop');

  it('fills tagline, an https support link and the brand colour from the public listing', () => {
    const r = prefillSite(site, 'shop', { tagline: "Shop's best: \"fast\" checkout", supportUrl: 'https://help.example/shop', themeColor: '#336699' });
    expect(r.prefilled).toEqual(['name', 'headline', 'ctaLabel', 'owner', 'legalUpdated', 'summary', 'supportUrl', 'colors']);
    expect(r.text).toContain('summary: "Shop\'s best: \\"fast\\" checkout"');
    expect(r.text).toContain('supportUrl: "https://help.example/shop"');
    expect(r.text).toContain('accent: "#336699"');
    expect(r.text).toMatch(/accentDeep: "#[0-9a-f]{6}"/);
    expect(r.text).toMatch(/accentSoft: "#[0-9a-f]{6}"/);
    expect(r.text).not.toContain('#d86f4d');
  });

  it('keeps the template defaults when the listing has nothing usable', () => {
    const r = prefillSite(site, 'shop', { tagline: '  ', supportUrl: 'javascript:alert(1)', themeColor: 'red' });
    expect(r.prefilled).toEqual(['name', 'headline', 'ctaLabel', 'owner', 'legalUpdated']);
    expect(r.text).toContain("supportUrl: ''");
    expect(r.text).toContain("accent: '#d86f4d'");
    expect(prefillSite(site, 'shop', null).prefilled).toEqual(['name', 'headline', 'ctaLabel', 'owner', 'legalUpdated']);
  });

  it('uses a given display name and date', () => {
    const r = prefillSite(site, 'shop', null, { name: 'ShopKit', today: '2026-11-12' });
    expect(r.text).toContain('name: "ShopKit"');
    expect(r.text).toContain('ctaLabel: "Open ShopKit"');
    expect(r.text).toContain('legalUpdated: "2026-11-12"');
  });

  it('manifestAppName reads vite.config.ts, then manifest.json, and ignores placeholders', () => {
    const vite = (n: string) => `VitePWA({ manifest: { short_name: 'S', name: ${n}, icons: [] } })`;
    expect(manifestAppName(vite("'GrassKarma'"), null)).toBe('GrassKarma');
    expect(manifestAppName(vite('"Two Words"'), '{"name":"Other"}')).toBe('Two Words');
    expect(manifestAppName(vite("'APPNAME'"), '{"name":"From JSON"}')).toBe('From JSON');
    expect(manifestAppName("defineConfig({ plugins: [] })", null)).toBeNull();
    expect(manifestAppName(null, 'not json')).toBeNull();
    expect(manifestAppName(null, '{"name":"  "}')).toBeNull();
  });

  it('detectAppId ignores an invalid .pas.json appId and strips a package scope', () => {
    writeFileSync(join(app, '.pas.json'), JSON.stringify({ appId: 'Bad Id' }));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@scope/inventory' }));
    expect(detectAppId(app)).toBe('inventory');
  });
});
