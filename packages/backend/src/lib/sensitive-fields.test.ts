import { describe, expect, it } from 'vitest';
import { isSensitiveField, sensitiveMatch } from './sensitive-fields.js';

// #294: one example set per pattern family, in the spellings an app's SQL produces.
export const SENSITIVE_FAMILIES: Record<string, string[]> = {
  password: ['password', 'user_password', 'passwd', 'pwd', 'passphrase', 'userPassword', 'passwordhash'],
  secret: ['secret', 'client_secret', 'webhook_secrets', 'clientSecret'],
  token: ['token', 'auth_token', 'refresh_token', 'accessToken', 'authtoken', 'tokens_used', 'jwt', 'bearer', 'bearer_value', 'session_cookie'],
  key: ['key', 'api_key', 'apiKey', 'APIKEY', 'private_key', 'privatekey', 'stripe_keys'],
  hash: ['hash', 'password_hash', 'pin_hashed'],
  salt: ['salt', 'password_salt'],
  credential: ['credential', 'credentials', 'aws_credentials', 'credentialid'],
  _internal: ['_internal', '_internal_notes', '_internalScore'],
};

describe('PAS-SENSITIVE-FIELDS (#294)', () => {
  for (const [family, names] of Object.entries(SENSITIVE_FAMILIES)) {
    it(`blocks the ${family} family`, () => {
      for (const name of names) expect(isSensitiveField(name), name).toBe(true);
    });
  }

  it('matches whole words, so ordinary columns pass', () => {
    for (const name of [
      'display_name', 'user_id', 'created_at', 'email', 'status', 'monkey', 'keyboard', 'keystone', 'turkey',
      'hashtag', 'secretary', 'tokenizer', 'saltwater', 'internal_notes', 'document_path', 'pocket_id',
    ]) expect(isSensitiveField(name), name).toBe(false);
  });

  it('says which term matched, for the registration error and the block log', () => {
    expect(sensitiveMatch('stripe_api_key')).toBe('key');
    expect(sensitiveMatch('accessToken')).toBe('token');
    expect(sensitiveMatch('apikeyvalue')).toBe('apikey');
    expect(sensitiveMatch('_internal_rank')).toBe('_internal');
    expect(sensitiveMatch('display_name')).toBeNull();
  });
});
