import { describe, expect, it } from 'vitest';
import {
  generateLogin, generatePassword, normalizeLogin, isValidLogin,
  normalizeEmail, isValidEmail, looksLikeEmail,
} from './credential-gen.js';

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

describe('credential email', () => {
  it('normalizeEmail trims + lowercases', () => {
    expect(normalizeEmail('  Teacher@School.EDU  ')).toBe('teacher@school.edu');
  });

  it('isValidEmail accepts ordinary addresses', () => {
    for (const ok of [
      'teacher@school.edu',
      'first.last@sub.domain.com',
      'a+tag@x.io',
      'o-brien@school.edu',
      `${'a'.repeat(64)}@school.edu`, // local part at the RFC 5321 limit
    ]) {
      expect(isValidEmail(ok), ok).toBe(true);
    }
  });

  it('isValidEmail rejects malformed and over-long addresses', () => {
    for (const bad of [
      '', 'not-an-email', '@nolocal.com', 'nodomain@', 'two@@at.com',
      'has space@school.edu', 'trailing.dot.@school.edu', '.leading@school.edu',
      'no-tld@school', 'dotted..local@school.edu', 'hyphen@-school.edu',
      'UPPER@school.edu', // callers must normalize first
      `${'a'.repeat(65)}@school.edu`, // local part over the limit
      `a@${'b'.repeat(250)}.com`, // whole address over 254
    ]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it('the login and email identifier spaces are disjoint', () => {
    // looksLikeEmail is the router in credentials/login. It is only safe while
    // nothing can be both — this is the guard on loosening either predicate.
    const emails = ['teacher@school.edu', 'a+tag@x.io'];
    const logins = ['rabbit-bear-wolf', 'user123', ...Array.from({ length: 20 }, generateLogin)];
    for (const e of emails) {
      expect(looksLikeEmail(e)).toBe(true);
      expect(isValidLogin(e)).toBe(false);
    }
    for (const l of logins) {
      expect(looksLikeEmail(l)).toBe(false);
      expect(isValidEmail(l)).toBe(false);
    }
  });
});
