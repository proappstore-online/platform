import { describe, expect, it } from 'vitest';
import { emailOrNull, handleOrNull } from './listing-validation.js';

describe('listing contact validation', () => {
  it('normalizes optional support email and rejects malformed values', () => {
    expect(emailOrNull(null)).toBeNull();
    expect(emailOrNull('user@example.com')).toBe('user@example.com');
    expect(() => emailOrNull('@bad')).toThrow('invalid email');
  });

  it('normalizes optional social handles and rejects malformed values', () => {
    expect(handleOrNull(null)).toBeNull();
    expect(handleOrNull('@validhandle')).toBe('validhandle');
    expect(() => handleOrNull('!!bad!!')).toThrow('invalid handle');
  });
});
