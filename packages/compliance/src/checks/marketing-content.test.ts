import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkMarketingContent, marketingFindings, RULE_SEVERITY } from './marketing-content.js';

// The template-app's marketing/src/site.ts as shipped (#398), verbatim.
const TEMPLATE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/marketing/template-site.ts.txt'), 'utf8');
// What `pas marketing add` leaves: the id and the title-cased name filled in, everything else the template's.
const scaffolded = (id: string, name: string) =>
  TEMPLATE.replaceAll('APPNAME', id).replace(`name: '${id}'`, `name: '${name}'`).replace(`Explore ${id}.`, `Explore ${name}.`).replace(`The ${id} team`, `The ${name} team`);
const rules = (src: string) => marketingFindings(src).map((f) => f.rule);
const site = (src: string) => mapFileSource(new Map([['marketing/src/site.ts', src]]));

/** A site an owner has actually written: own copy, operator, contact, law, imagery. */
const WRITTEN = `export const site = {
  appId: 'shop',
  name: 'Shop',
  owner: 'Ada Lovelace Pty Ltd',
  contactEmail: 'hello@shop.example',
  governingLaw: 'Victoria, Australia',
  headline: 'Run your stall from your phone.',
  summary: 'Stock, orders and payouts for market stallholders.',
  heroImage: { src: '/assets/hero.png', alt: 'The stall dashboard', width: 1200, height: 900 } as Image | null,
  screenshots: [{ src: '/assets/a.png', alt: 'Orders', width: 1200, height: 900 }] as Image[],
  benefits: [{ title: 'Know your stock', body: 'See what is left before the market opens.' }],
  howItWorks: [{ title: 'Open the app', body: 'Add your first product.' }],
}`;

describe('marketing-content (#498)', () => {
  it('flags every part of the template as shipped: copy, operator, contact, law, imagery', async () => {
    const r = await checkMarketingContent(site(TEMPLATE));
    expect(r.status).toBe('warn');
    for (const rule of ['placeholder', 'template-copy', 'operator-contact', 'imagery']) expect(r.detail).toContain(`${rule}:`);
    expect(r.detail).toContain('APPNAME was never replaced');
    expect(r.suggestions?.join(' ')).toMatch(/marketing\/src\/site\.ts/);
  });

  it('flags a scaffolded but unedited site: headline, summary, benefits, steps, default owner, empty contact and law, no images', () => {
    const f = marketingFindings(scaffolded('shop', 'Shop'));
    const what = f.map((x) => x.what).join(' | ');
    expect(what).toContain('headline "Explore Shop."');
    expect(what).toContain('summary is the template sentence');
    expect(what).toContain('3 of 3 benefits are the template\'s');
    expect(what).toContain('how-it-works step');
    expect(what).toContain('operator "The Shop team" is the default');
    expect(what).toContain('no contactEmail');
    expect(what).toContain('no governing law');
    expect(what).toContain('no hero image and no screenshots; the social preview is the app icon');
    expect(f.some((x) => x.rule === 'placeholder')).toBe(false); // APPNAME was replaced
  });

  it('passes a site the owner has written', async () => {
    expect(marketingFindings(WRITTEN)).toEqual([]);
    expect((await checkMarketingContent(site(WRITTEN))).status).toBe('pass');
  });

  it('reads the bookkeeper case from the issue: real copy, but the default owner, no contact or law', () => {
    const src = WRITTEN.replace("'Ada Lovelace Pty Ltd'", "'The Shop team'").replace("'hello@shop.example'", "''").replace("'Victoria, Australia'", "''");
    expect(rules(src).sort()).toEqual(['operator-contact', 'operator-contact', 'operator-contact']);
  });

  it('a hero image alone or screenshots alone still warns about the other, and an owner-written site with neither names both', () => {
    expect(marketingFindings(WRITTEN.replace(/screenshots: \[.*\] as Image\[\],/, 'screenshots: [] as Image[],')).map((f) => f.what)).toEqual(['no screenshots']);
    expect(marketingFindings(WRITTEN.replace(/heroImage: \{.*\} as Image \| null,/, 'heroImage: null as Image | null,')).map((f) => f.what)).toEqual(['no hero image; the social preview is the app icon']);
  });

  it('recognises only the template\'s own words: a short, honest benefit list passes', () => {
    expect(rules(WRITTEN.replace("'Know your stock'", "'Fast'").replace("'See what is left before the market opens.'", "'Quick.'"))).toEqual([]);
  });

  it('is skipped for an app with no marketing site, and never throws on an unrecognisable site.ts', async () => {
    expect((await checkMarketingContent(mapFileSource(new Map([['web/src/App.tsx', 'x']])))).detail).toBe('no marketing site');
    expect(marketingFindings('export default {}').map((f) => f.rule)).toEqual(['operator-contact', 'operator-contact', 'imagery']);
  });

  it('ignores a placeholder that only appears in a comment', () => {
    expect(rules(`// APPNAME ... \n${WRITTEN}`)).toEqual([]);
  });

  it('ships as warn for every rule', () => {
    expect(Object.values(RULE_SEVERITY).every((s) => s === 'warn')).toBe(true);
  });
});
