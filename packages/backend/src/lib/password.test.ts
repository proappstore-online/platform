import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing (PBKDF2-SHA256)', () => {
  it('produces a self-describing pbkdf2 hash, never plaintext', async () => {
    const hash = await hashPassword('tigerwolf42', 1000); // low iters for test speed
    expect(hash.startsWith('pbkdf2$1000$')).toBe(true);
    expect(hash).not.toContain('tigerwolf42');
    expect(hash.split('$')).toHaveLength(4);
  });

  it('verifies the correct password and rejects the wrong one', async () => {
    const hash = await hashPassword('rabbit-bear-wolf', 1000);
    expect(await verifyPassword('rabbit-bear-wolf', hash)).toBe(true);
    expect(await verifyPassword('rabbit-bear-fox', hash)).toBe(false);
  });

  it('salts: same password hashes to different strings', async () => {
    const a = await hashPassword('same', 1000);
    const b = await hashPassword('same', 1000);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('returns false (never throws) on a malformed stored hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$abc$salt$hash')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});
