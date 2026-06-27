import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { seedFiles } from './template-seed.ts';

/**
 * The platform OWNS CI: handleAgentDeploy (admin/src/publish.ts) strips every
 * .github/workflows/* from the bundle and injects the single canonical
 * deployWorkflowYaml() at deploy time. Seeding a workflow here is therefore dead
 * code — and historically WRONG (the old seed deployed to Cloudflare Pages, the
 * abandoned Path-A model). This test locks that in: the seed must never emit a
 * workflow file again, so a future edit can't silently reintroduce drift.
 */
describe('seedFiles — platform owns CI, seed carries no workflow', () => {
  const files = seedFiles('demo-app');

  it('seeds NO .github/workflows/* files', () => {
    const workflows = [...files.keys()].filter((p) => /^\.github\/workflows\//.test(p));
    expect(workflows).toEqual([]);
  });

  it('still seeds the real app scaffold (package.json, vite, index.html, src)', () => {
    // Sanity: removing the workflows must not have gutted the scaffold.
    expect(files.has('package.json')).toBe(true);
    expect(files.has('index.html')).toBe(true);
    expect([...files.keys()].some((p) => p.startsWith('src/'))).toBe(true);
  });

  it('never references Cloudflare Pages (Path B / R2 only)', () => {
    // The removed seed deployed via `wrangler pages deploy`. Guard against any
    // file reintroducing the abandoned Path-A model.
    for (const content of files.values()) {
      expect(content).not.toContain('pages deploy');
    }
  });
});

/**
 * Drift detection: the seed's index.html must match the canonical template-app
 * on every <meta> tag that affects mobile behavior, PWA, SEO, and theming.
 * The template (pas/templates/template-app/web/index.html) is the source of
 * truth. If this test fails, update template-seed.ts to match the template —
 * never the other way around.
 */
describe('seedFiles — index.html matches template-app (drift detection)', () => {
  const templatePath = resolve(__dirname, '../../../../templates/template-app/web/index.html');
  const templateHtml = readFileSync(templatePath, 'utf8');
  const seedHtml = seedFiles('demo-app').get('index.html')!;

  /** Extract the content="" value of a <meta> tag by name or property. */
  function metaContent(html: string, attr: string): string | null {
    const re = new RegExp(`<meta\\s+[^>]*(?:name|property|http-equiv)=["']${attr}["'][^>]*content=["']([^"']*)["']`, 'i');
    const m2 = new RegExp(`<meta\\s+[^>]*content=["']([^"']*)["'][^>]*(?:name|property|http-equiv)=["']${attr}["']`, 'i');
    return (html.match(re)?.[1] ?? html.match(m2)?.[1]) ?? null;
  }

  /** Check if a tag exists anywhere in the HTML (ignoring attribute values). */
  function hasTag(html: string, tag: string): boolean {
    return html.includes(tag);
  }

  it('viewport meta matches (zoom, scale, viewport-fit)', () => {
    const tpl = metaContent(templateHtml, 'viewport')!;
    const seed = metaContent(seedHtml, 'viewport')!;
    expect(seed).toBe(tpl);
  });

  it('apple-mobile-web-app-capable is present', () => {
    expect(metaContent(seedHtml, 'apple-mobile-web-app-capable')).toBe(
      metaContent(templateHtml, 'apple-mobile-web-app-capable'),
    );
  });

  it('mobile-web-app-capable is present', () => {
    expect(hasTag(seedHtml, 'mobile-web-app-capable')).toBe(
      hasTag(templateHtml, 'mobile-web-app-capable'),
    );
  });

  it('apple-mobile-web-app-status-bar-style matches', () => {
    expect(metaContent(seedHtml, 'apple-mobile-web-app-status-bar-style')).toBe(
      metaContent(templateHtml, 'apple-mobile-web-app-status-bar-style'),
    );
  });

  it('darkreader-lock is present', () => {
    expect(hasTag(seedHtml, 'darkreader-lock')).toBe(
      hasTag(templateHtml, 'darkreader-lock'),
    );
  });

  it('Google Fonts preconnect is present', () => {
    expect(hasTag(seedHtml, 'fonts.googleapis.com')).toBe(true);
    expect(hasTag(seedHtml, 'fonts.gstatic.com')).toBe(true);
  });

  it('platform analytics script is present', () => {
    expect(hasTag(seedHtml, 'api.proappstore.online/v1/analytics.js')).toBe(true);
  });
});
