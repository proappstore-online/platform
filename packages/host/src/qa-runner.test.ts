import { describe, expect, it } from 'vitest';
import { handleQaRunner, QA_PREFIX } from './qa-runner.js';
import type { ResolvedRoute } from './host.js';

const route: ResolvedRoute = {
  slug: 'chess-academy',
  zone: 'proappstore.online',
  r2_prefix: 'apps/chess-academy',
  store: 'pas',
  matched: 'platform',
};

const req = (path: string, method = 'GET') =>
  new Request(`https://chess-academy.proappstore.online${path}`, { method });

describe('handleQaRunner', () => {
  it('ignores non-/__qa paths', () => {
    expect(handleQaRunner(req('/'), route)).toBeNull();
    expect(handleQaRunner(req('/puzzles'), route)).toBeNull();
    expect(handleQaRunner(req('/__qattack'), route)).toBeNull();
  });

  it('serves the runner page at /__qa and /__qa/ with no-store + noindex', async () => {
    for (const path of [QA_PREFIX, `${QA_PREFIX}/`]) {
      const res = handleQaRunner(req(path), route)!;
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
      const html = await res.text();
      expect(html).toContain('QA runner — chess-academy');
      expect(html).toContain('<iframe id="app" src="/"');
      expect(html).toContain(`${QA_PREFIX}/runner.js`);
    }
  });

  it('serves the bundle + glue at /__qa/runner.js', async () => {
    const res = handleQaRunner(req(`${QA_PREFIX}/runner.js`), route)!;
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('javascript');
    const js = await res.text();
    expect(js).toContain('__pasQaRunner'); // dom-runner bundle global
    expect(js).toContain('"chess-academy"'); // app id baked into glue
    expect(js).toContain('/.pas/api'); // all data via cookie mediation
  });

  it('escapes the app id in HTML output', async () => {
    const evil = { ...route, slug: '<script>alert(1)</script>' };
    const res = handleQaRunner(req(`${QA_PREFIX}/`), evil)!;
    const html = await res.text();
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('rejects non-GET methods', () => {
    const res = handleQaRunner(req(`${QA_PREFIX}/`, 'POST'), route)!;
    expect(res.status).toBe(405);
  });
});
