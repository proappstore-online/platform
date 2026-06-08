import { describe, expect, it } from 'vitest';
import { generateLogin, generatePassword, normalizeLogin, isValidLogin } from './credential-gen.js';

describe('credential generation', () => {
  it('generateLogin is a lowercase animal-animal-animal triple', () => {
    for (let i = 0; i < 50; i++) {
      const login = generateLogin();
      expect(login).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
      expect(isValidLogin(login)).toBe(true);
    }
  });

  it('generatePassword is readable and ≥ 6 chars', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword();
      expect(pw).toMatch(/^[a-z]+\d\d$/);
      expect(pw.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('normalizeLogin trims + lowercases', () => {
    expect(normalizeLogin('  Rabbit-Bear-Wolf  ')).toBe('rabbit-bear-wolf');
  });

  it('isValidLogin accepts hyphenated lowercase, rejects junk', () => {
    expect(isValidLogin('rabbit-bear-wolf')).toBe(true);
    expect(isValidLogin('user123')).toBe(true);
    expect(isValidLogin('Has Spaces')).toBe(false);
    expect(isValidLogin('UPPER')).toBe(false);
    expect(isValidLogin('-leading')).toBe(false);
    expect(isValidLogin('trailing-')).toBe(false);
    expect(isValidLogin('ab')).toBe(false); // too short
    expect(isValidLogin('x'.repeat(65))).toBe(false); // too long
  });
});
