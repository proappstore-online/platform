import { describe, expect, it } from 'vitest';
import {
  bustIconCache as cliBustIconCache,
  deployPublishesMarketing as cliDeployPublishesMarketing,
  manifestAppName as cliManifestAppName,
  prefillSite as cliPrefillSite,
} from '../../cli/src/marketing.ts';
import { bustIconCache, deployPublishesMarketing, manifestAppName, MARKETING_SCRIPTS, prefillSite, type MarketingListing } from './marketing-site.ts';

// #421: the MCP add_marketing_site tool pre-fills marketing/src/site.ts exactly
// as `pas marketing add` (#410) does. The CLI keeps its own copy (it is
// published and cannot depend on this private package), so the two are held
// to the same output here.

const SITE_TS = `export const site = {
  appId: 'shop',
  name: 'shop',
  owner: 'The shop team',
  supportUrl: '',
  legalUpdated: '2026-10-18',
  colors: {
    accent: '#d86f4d',
    accentDeep: '#9f4427',
    accentSoft: '#ffd4bf',
  },
  headline: 'Explore shop.',
  summary: 'Describe in one or two sentences what shop does and who it is for.',
  ctaLabel: 'Open shop',
}
`;

describe('prefillSite (#421)', () => {
  it('names the app and fills summary, support link and brand colours from the listing', () => {
    const { text, prefilled } = prefillSite(SITE_TS, 'chess-academy', {
      tagline: 'Learn chess with friends.', supportUrl: 'https://help.example', themeColor: '#336699',
    });
    expect(prefilled).toEqual(['name', 'headline', 'ctaLabel', 'owner', 'legalUpdated', 'summary', 'supportUrl', 'colors']);
    expect(text).toContain('name: "Chess Academy"');
    expect(text).toContain('headline: "Explore Chess Academy."');
    expect(text).toContain('summary: "Learn chess with friends."');
    expect(text).toContain('supportUrl: "https://help.example"');
    expect(text).toContain('accent: "#336699"');
  });

  it('leaves the template defaults when there is no listing, and ignores unsafe values', () => {
    const none = prefillSite(SITE_TS, 'shop', null);
    expect(none.prefilled).toEqual(['name', 'headline', 'ctaLabel', 'owner', 'legalUpdated']);
    expect(none.text).toContain(`legalUpdated: "${new Date().toISOString().slice(0, 10)}"`);
    expect(none.text).toContain("accent: '#d86f4d'");
    const bad = prefillSite(SITE_TS, 'shop', { supportUrl: 'javascript:alert(1)', themeColor: 'red' });
    expect(bad.prefilled).not.toContain('supportUrl');
    expect(bad.prefilled).not.toContain('colors');
  });

  it.each<[string, MarketingListing | null]>([
    ['shop', null],
    ['chess-academy', { tagline: 'Learn chess.', supportUrl: 'https://x.example/help', themeColor: '#ABCDEF' }],
    ['a--b', { longDescription: '  A long description '.repeat(30), themeColor: '#000000' }],
    ['crm', { tagline: 'Quote "this" \\ that', supportUrl: 'http://insecure.example' }],
  ])('matches the CLI copy for %s', (appId, listing) => {
    expect(prefillSite(SITE_TS, appId, listing)).toEqual(cliPrefillSite(SITE_TS, appId, listing));
    const opts = { name: 'GrassKarma', today: '2026-11-12' };
    expect(prefillSite(SITE_TS, appId, listing, opts)).toEqual(cliPrefillSite(SITE_TS, appId, listing, opts));
  });

  // #589: the manifest name, not the capitalised id; the scaffold date, not the template's.
  it('uses the given display name and date', () => {
    const { text } = prefillSite(SITE_TS, 'grasskarma', null, { name: 'GrassKarma', today: '2026-11-12' });
    expect(text).toContain('name: "GrassKarma"');
    expect(text).toContain('headline: "Explore GrassKarma."');
    expect(text).toContain('owner: "The GrassKarma team"');
    expect(text).toContain('legalUpdated: "2026-11-12"');
  });
});

describe('manifestAppName and bustIconCache (#589)', () => {
  it.each<[string | null, string | null, string | null]>([
    ["VitePWA({\n  manifest: {\n    name: 'GrassKarma',\n    short_name: 'GK',\n  },\n})", null, 'GrassKarma'],
    ["manifest: { short_name: 'S', name: \"Two Words\" }", '{"name":"Other"}', 'Two Words'],
    ["manifest: { name: 'APPNAME' }", '{"name":"From JSON"}', 'From JSON'],
    ['defineConfig({})', null, null],
    [null, 'not json', null],
  ])('%j / %j → %j, and the CLI copy agrees', (vite, json, expected) => {
    expect(manifestAppName(vite, json)).toBe(expected);
    expect(cliManifestAppName(vite, json)).toBe(expected);
  });

  it('rewrites every icon cache key, as the CLI does', () => {
    const layout = "new URL(site.heroImage?.src ?? '/icon-512.png?v=neutral-1', Astro.site)\n<link href=\"/icon-192.png?v=neutral-1\" />\n<img src=\"/assets/x.png?v=1\" />";
    const out = bustIconCache(layout, 'app-1234abcd');
    expect(out).toContain("'/icon-512.png?v=app-1234abcd'");
    expect(out).toContain('"/icon-192.png?v=app-1234abcd"');
    expect(out).toContain('/assets/x.png?v=1');
    expect(cliBustIconCache(layout, 'app-1234abcd')).toBe(out);
  });

  it('adds the same root scripts as the CLI', () => {
    expect(MARKETING_SCRIPTS).toEqual({
      'dev:marketing': 'pnpm --dir marketing --ignore-workspace dev',
      'build:marketing': 'pnpm --dir marketing --ignore-workspace build',
    });
  });
});

describe('deployPublishesMarketing (#427)', () => {
  const caller = 'jobs:\n  deploy:\n    uses: proappstore-online/platform/.github/workflows/app-deploy.yml@app-deploy-v1\n    secrets: inherit\n';
  const cases: [string, boolean][] = [
    ['      - name: Publish marketing site (marketing/ -> about-<app>, keyless)\n', true],
    ['      - name: Upload to R2\n', false],
    [caller, true],
    [caller.replace('    secrets: inherit', '    with:\n      marketing: false\n    secrets: inherit'), false],
    [caller.replace('    secrets: inherit', '    with:\n      marketing: auto\n    secrets: inherit'), true],
    ['', false],
  ];
  it.each(cases)('%j → %s, and the CLI copy agrees', (yaml, expected) => {
    expect(deployPublishesMarketing(yaml)).toBe(expected);
    expect(cliDeployPublishesMarketing(yaml)).toBe(expected);
  });
});
