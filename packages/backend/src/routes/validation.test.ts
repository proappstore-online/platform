import { describe, expect, it } from 'vitest';
import { validNewAppId } from './validation.js';

describe('new app IDs for dedicated marketing hostnames', () => {
  it('accepts the longest DNS-safe ID and reserves the about prefix', () => {
    expect(validNewAppId('a'.repeat(57))).toBe(true);
    expect(validNewAppId('a'.repeat(58))).toBe(false);
    expect(validNewAppId('about-chess')).toBe(false);
    expect(validNewAppId('chess-clubs')).toBe(true);
  });
});
