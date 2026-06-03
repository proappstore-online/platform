import { describe, it, expect } from 'vitest';
import { internalTokenOk } from './internal-auth.ts';

describe('internalTokenOk', () => {
  it('accepts a matching token', () => {
    expect(internalTokenOk('s3cr3t', 's3cr3t')).toBe(true);
  });
  it('rejects a mismatch', () => {
    expect(internalTokenOk('nope', 's3cr3t')).toBe(false);
  });
  it('rejects when no token configured — even if both sides are empty/undefined', () => {
    expect(internalTokenOk(undefined, undefined)).toBe(false);
    expect(internalTokenOk('', '')).toBe(false);
    expect(internalTokenOk(null, undefined)).toBe(false);
  });
  it('rejects a missing header against a configured token', () => {
    expect(internalTokenOk(null, 's3cr3t')).toBe(false);
    expect(internalTokenOk(undefined, 's3cr3t')).toBe(false);
  });
});
