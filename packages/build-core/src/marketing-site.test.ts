import { describe, expect, it } from 'vitest';
import { deployPublishesMarketing as cliDeployPublishesMarketing, prefillSite as cliPrefillSite } from '../../cli/src/marketing.ts';
import { deployPublishesMarketing, MARKETING_SCRIPTS, prefillSite, type MarketingListing } from './marketing-site.ts';

// #421: the MCP add_marketing_site tool pre-fills marketing/src/site.ts exactly
// as `pas marketing add` (#410) does. The CLI keeps its own copy (it is
// published and cannot depend on this private package), so the two are held
// to the same output here.

const SITE_TS = `export const site = {
  appId: 'shop',
  name: 'shop',
  owner: 'The shop team',
  supportUrl: '',
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
    expect(prefilled).toEqual(['name', 'headline', 'ctaLabel', 'owner', 'summary', 'supportUrl', 'colors']);
    expect(text).toContain('name: "Chess Academy"');
    expect(text).toContain('headline: "Explore Chess Academy."');
    expect(text).toContain('summary: "Learn chess with friends."');
    expect(text).toContain('supportUrl: "https://help.example"');
    expect(text).toContain('accent: "#336699"');
  });

  it('leaves the template defaults when there is no listing, and ignores unsafe values', () => {
    const none = prefillSite(SITE_TS, 'shop', null);
    expect(none.prefilled).toEqual(['name', 'headline', 'ctaLabel', 'owner']);
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
