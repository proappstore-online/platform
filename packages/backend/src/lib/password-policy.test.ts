import { describe, expect, it } from 'vitest';
import { SELF_REGISTRATION_MIN_PASSWORD, checkSelfRegistrationPassword } from './password-policy.js';

describe('self-registration password policy (#118)', () => {
  const email = 'alice@example.com';
  it('requires 12 characters — stricter than the 6-character child path', () => {
    expect(SELF_REGISTRATION_MIN_PASSWORD).toBe(12);
    expect(checkSelfRegistrationPassword('short1short', email)).toMatch(/at least 12/);
    expect(checkSelfRegistrationPassword('correct-horse-battery', email)).toBeNull();
  });
  it('rejects common passwords even when padded with symbols or case', () => {
    for (const p of ['password1234', 'Password1234!', 'qwerty123456', 'iloveyou1234', '123456789012', 'letmein12345']) {
      expect(checkSelfRegistrationPassword(p, email), p).toMatch(/too common|repeated|digits only/);
    }
  });
  it('rejects a single repeated character and the email local part', () => {
    expect(checkSelfRegistrationPassword('aaaaaaaaaaaa', email)).toMatch(/repeated/);
    expect(checkSelfRegistrationPassword('alice.smith!', 'alice.smith@example.com')).toMatch(/email address/);
  });
  it('accepts a long passphrase and caps length', () => {
    expect(checkSelfRegistrationPassword('the quick brown fox jumps', email)).toBeNull();
    expect(checkSelfRegistrationPassword('x'.repeat(257) + 'y', email)).toMatch(/at most/);
  });
});
