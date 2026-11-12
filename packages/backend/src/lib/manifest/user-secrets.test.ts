import { describe, expect, it } from 'vitest';
import { validateUserSecrets } from './user-secrets.js';

const OPENAI = { name: 'OPENAI_KEY', label: 'OpenAI admin key', description: 'Reads your organization costs' };

describe('validateUserSecrets (#587)', () => {
  it('treats an absent section as no names', () => {
    expect(validateUserSecrets(undefined)).toEqual({ userSecrets: [] });
    expect(validateUserSecrets(null)).toEqual({ userSecrets: [] });
  });

  it('accepts { name, label, description } entries', () => {
    expect(validateUserSecrets([OPENAI])).toEqual({ userSecrets: [OPENAI] });
  });

  it('refuses unknown fields, bad names, duplicates and missing text', () => {
    expect(validateUserSecrets({})).toMatchObject({ error: expect.stringContaining('user_secrets must be an array') });
    expect(validateUserSecrets([{ ...OPENAI, scope: 'app' }])).toEqual({ error: 'user_secrets[0]: unknown field "scope"' });
    expect(validateUserSecrets([{ ...OPENAI, name: 'openai' }])).toMatchObject({ error: expect.stringContaining('user_secrets[0].name must match') });
    expect(validateUserSecrets([OPENAI, OPENAI])).toEqual({ error: 'user_secrets[1]: duplicate name "OPENAI_KEY"' });
    expect(validateUserSecrets([{ ...OPENAI, label: ' ' }])).toMatchObject({ error: expect.stringContaining('user_secrets[0].label') });
    expect(validateUserSecrets([{ name: 'A', label: 'A' }])).toMatchObject({ error: expect.stringContaining('user_secrets[0].description') });
    expect(validateUserSecrets(['OPENAI_KEY'])).toEqual({ error: 'user_secrets[0] must be an object' });
  });

  it('caps the number of names', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ ...OPENAI, name: `KEY_${i}` }));
    expect(validateUserSecrets(many)).toMatchObject({ error: expect.stringContaining('at most 10') });
  });
});
