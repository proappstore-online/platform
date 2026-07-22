import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkAccessibilityStatic } from './accessibility-static.js';

describe('checkAccessibilityStatic', () => {
  it('passes when basic accessible names are present', async () => {
    const r = await checkAccessibilityStatic(mapFileSource(new Map([
      ['web/src/App.tsx', `
        <img src="/logo.png" alt="Logo" />
        <img src="/decoration.png" alt="" />
        <button aria-label="Close"><X /></button>
        <button>Save</button>
        <label htmlFor="email">Email</label><input id="email" />
        <label>Name<input /></label>
        <textarea aria-label="Notes" />
        <select aria-labelledby="sort-label" />
      `],
    ])));
    expect(r.status).toBe('pass');
  });

  it('fails for images without alt text', async () => {
    const r = await checkAccessibilityStatic(mapFileSource(new Map([
      ['web/src/App.tsx', '<img src="/logo.png" />'],
    ])));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/missing alt text/);
  });

  it('fails for icon-only buttons without an accessible name', async () => {
    const r = await checkAccessibilityStatic(mapFileSource(new Map([
      ['web/src/App.tsx', '<button><X /></button>'],
    ])));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/button/);
  });

  it('fails for unlabeled text inputs', async () => {
    const r = await checkAccessibilityStatic(mapFileSource(new Map([
      ['web/src/App.tsx', '<input type="text" />'],
    ])));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/input/);
  });

  it('ignores controls that do not need labels', async () => {
    const r = await checkAccessibilityStatic(mapFileSource(new Map([
      ['web/src/App.tsx', '<input type="hidden" /><input type="checkbox" /><input type="submit" />'],
    ])));
    expect(r.status).toBe('pass');
  });
});

  it('handles pathological unclosed-<button> input without catastrophic backtracking (ReDoS guard)', async () => {
    // Before the linear rewrite, N unclosed `<button>` open tags drove O(N^2)
    // backtracking (0.8MB → ~40s). This must now complete near-instantly.
    const content = '<button>'.repeat(50_000); // ~0.4MB of open tags, none closed
    const start = Date.now();
    const r = await checkAccessibilityStatic(mapFileSource(new Map([['web/src/App.tsx', content]])));
    const elapsed = Date.now() - start;
    expect(r.status).toBeDefined();
    expect(elapsed).toBeLessThan(2000); // linear: milliseconds, not tens of seconds
  });
