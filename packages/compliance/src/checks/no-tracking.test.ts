import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkNoTracking } from './no-tracking.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-'));
  await mkdir(join(dir, 'web'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkNoTracking', () => {
  it('passes when no tracking strings anywhere', async () => {
    await writeFile(join(dir, 'web', 'app.ts'), 'export const x = 1;');
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('fails on google-analytics in source', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      '<script src="https://www.google-analytics.com/analytics.js"></script>',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/google-analytics/);
  });

  it('fails on plausible / posthog as deps even though those are privacy-respecting', async () => {
    // ProAppStore policy is *no* analytics, even the privacy-respecting ones.
    await writeFile(join(dir, 'web', 'package.json'), '{"dependencies":{"posthog-js":"1.0.0"}}');
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/posthog/);
  });

  it('does not scan dist or node_modules (skipped by walk)', async () => {
    await mkdir(join(dir, 'node_modules', 'posthog-js'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'posthog-js', 'index.js'), '// posthog stuff');
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist', 'bundle.js'), 'amplitude.track("x")');
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  // --- ambiguous-English-word false positives that bit billiards / pinball ---

  it('does not flag the bare word "segment" as a geometry term', async () => {
    await writeFile(
      join(dir, 'web', 'physics.ts'),
      [
        '// Closest point on segment a→b',
        'function projectOntoSegment(p, a, b) { return p; }',
        'const segment = { a, b };',
        'const collideSegment = (x) => x;',
      ].join('\n'),
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('flags Segment analytics SDK by scoped import', async () => {
    await writeFile(
      join(dir, 'web', 'analytics.ts'),
      "import { AnalyticsBrowser } from '@segment/analytics-next';",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/segment/);
  });

  it('flags Segment analytics SDK by window.analytics.track call', async () => {
    await writeFile(
      join(dir, 'web', 'page.ts'),
      "window.analytics.track('button_click', { id: 'x' });",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/segment/);
  });

  it('does not flag the bare word "amplitude" as an oscillation parameter', async () => {
    await writeFile(
      join(dir, 'web', 'shake.ts'),
      [
        '// tilt shake amplitude in pixels',
        'const amplitude = 6;',
        'function applyShake(t, amplitude) { return amplitude * Math.sin(t); }',
      ].join('\n'),
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('flags Amplitude SDK by scoped import', async () => {
    await writeFile(
      join(dir, 'web', 'analytics.ts'),
      "import * as amplitude from '@amplitude/analytics-browser';",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/amplitude/);
  });

  it('flags Amplitude SDK by .init() call', async () => {
    await writeFile(
      join(dir, 'web', 'analytics.ts'),
      "amplitude.init('API_KEY', 'user@example.com');",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/amplitude/);
  });

  it('does not flag a variable named gtag in unrelated code', async () => {
    // `gtag` as a bare identifier is extremely rare outside GA, but make sure
    // a stray variable named gtag (e.g. in a typing-game word list) doesn't trip.
    await writeFile(join(dir, 'web', 'wordlist.ts'), "const words = ['gtag', 'span', 'div'];");
    const r = await checkNoTracking(fsFileSource(dir));
    // The pattern requires `gtag(` or `window.gtag` — a string literal alone passes.
    expect(r.status).toBe('pass');
  });

  it('flags gtag config call', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      "<script>gtag('config', 'G-XXXX');</script>",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/gtag/);
  });

  // --- comment-stripping regression guards ---

  it('ignores tracker names that only appear in a // line comment', async () => {
    await writeFile(
      join(dir, 'web', 'App.tsx'),
      '// We do NOT use google-analytics. See platform policy.\nexport {};',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('ignores tracker names inside a /** JSDoc */ block', async () => {
    await writeFile(
      join(dir, 'web', 'lib.ts'),
      '/** Do not add @amplitude/analytics-browser here. */\nexport {};',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('ignores tracker references inside <!-- HTML --> comments', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      '<!-- This site does NOT load google-analytics or @amplitude/* -->\n<body></body>',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });
});
