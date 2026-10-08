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
  // #335: a digit glued to the word, and one-word compounds ending in secret/token or a listed …key.
  digits: ['token2', 'secret1', 'client_secret2', 'api_key2', 'Token2Fa', 'password1'],
  compounds: [
    'clientsecret', 'sessiontoken', 'webhooksecret', 'secretkey', 'signingkey', 'idtoken', 'csrftoken', 'otpsecret',
    'privkey', 'hmackey', 'idtokens', 'webhooksecrets', 'encryptionkey',
  ],
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

  // #335: the digit split and the secret/token suffix rule must not pull these in. `key` deliberately has no
  // suffix rule (monkey, turkey, hockey end in it); `…key` secrets are listed compounds instead.
  it('keeps benign names with digits, key-endings and secret/token prefixes out', () => {
    for (const name of [
      'keyword', 'tokenizer_mode', 'hockey', 'donkey', 'whiskey', 'secretariat', 'address2', 'line1', 'level2',
      'sha256_digest', 'ipv4_address', 'utm_source2', 'top10_scores',
    ]) expect(sensitiveMatch(name), name).toBeNull();
  });

  it('says which term matched, for the registration error and the block log', () => {
    expect(sensitiveMatch('stripe_api_key')).toBe('key');
    expect(sensitiveMatch('accessToken')).toBe('token');
    expect(sensitiveMatch('apikeyvalue')).toBe('apikey');
    expect(sensitiveMatch('_internal_rank')).toBe('_internal');
    expect(sensitiveMatch('token2')).toBe('token');
    expect(sensitiveMatch('webhooksecret')).toBe('secret');
    expect(sensitiveMatch('signingkey')).toBe('signingkey');
    expect(sensitiveMatch('display_name')).toBeNull();
  });
});
