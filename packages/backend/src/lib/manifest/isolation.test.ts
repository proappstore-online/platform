import { describe, expect, it } from 'vitest';
import { ISOLATION_MODES, validateIsolation } from './isolation.js';

describe('validateIsolation (#452)', () => {
  it('treats absent, null and "none" as the default: not isolated', () => {
    for (const v of [undefined, null, 'none']) expect(validateIsolation(v), String(v)).toEqual({ isolation: null });
  });

  it('accepts exactly the two modes', () => {
    expect(ISOLATION_MODES).toEqual(['cross-origin', 'cross-origin-strict']);
    expect(validateIsolation('cross-origin')).toEqual({ isolation: 'cross-origin' });
    expect(validateIsolation('cross-origin-strict')).toEqual({ isolation: 'cross-origin-strict' });
  });

  it.each([
    ['an unknown mode', 'same-origin'],
    ['different case', 'Cross-Origin'],
    ['padding', ' cross-origin'],
    ['an empty string', ''],
    ['true', true],
    ['false', false],
    ['a number', 1],
    ['an object', { mode: 'cross-origin' }],
    ['an array', ['cross-origin']],
  ])('refuses %s', (_label, value) => {
    expect(validateIsolation(value)).toEqual({ error: 'isolation must be "cross-origin" or "cross-origin-strict" (or omitted for the default, not isolated)' });
  });
});
