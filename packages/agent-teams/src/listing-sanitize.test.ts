import { describe, expect, it } from 'vitest';
import { sanitizeListing } from './project-do.js';

// #91: generate-listing feeds untrusted repo content to the model, so its output
// must be coerced — validated category, clamped lengths, no injected keys.
describe('sanitizeListing (#91)', () => {
  it('validates category against the allow-list (else "other")', () => {
    expect(sanitizeListing({ category: 'productivity' }).category).toBe('productivity');
    expect(sanitizeListing({ category: 'platform_admin' }).category).toBe('other');
    expect(sanitizeListing({ category: '<script>' }).category).toBe('other');
    expect(sanitizeListing({}).category).toBe('other');
  });

  it('clamps lengths and drops any injected extra keys', () => {
    const out = sanitizeListing({
      tagline: 'x'.repeat(500),
      longDescription: 'y'.repeat(9000),
      category: 'tools',
      isAdmin: true,
      __proto__: { polluted: true },
    });
    expect(out.tagline.length).toBe(120);
    expect(out.longDescription.length).toBe(4000);
    expect(out.category).toBe('tools');
    expect(Object.keys(out).sort()).toEqual(['category', 'longDescription', 'tagline']);
  });

  it('coerces non-string fields to empty', () => {
    const out = sanitizeListing({ tagline: { evil: 1 }, longDescription: 42, category: null });
    expect(out.tagline).toBe('');
    expect(out.longDescription).toBe('');
    expect(out.category).toBe('other');
  });

  it('tolerates non-object input', () => {
    expect(sanitizeListing('nope').category).toBe('other');
    expect(sanitizeListing(null).tagline).toBe('');
  });
});
