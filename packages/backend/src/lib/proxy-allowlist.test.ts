import { describe, expect, it } from 'vitest';
import { validateRule, pickRule, injectSecret, isAiProviderHost, AllowlistError, type AllowlistRule } from './proxy-allowlist.js';

describe('validateRule', () => {
  const valid = {
    pattern: 'https://api.example.com/v1/',
    injectKind: 'bearer',
    injectName: '',
    secretName: 'MY_KEY',
    methods: ['GET', 'POST'],
  };

  it('accepts a valid bearer rule', () => {
    const rule = validateRule(valid);
    expect(rule.pattern).toBe('https://api.example.com/v1/');
    expect(rule.injectKind).toBe('bearer');
    expect(rule.methods).toEqual(['GET', 'POST']);
  });

  it('accepts a valid header rule', () => {
    const rule = validateRule({ ...valid, injectKind: 'header', injectName: 'X-API-Key' });
    expect(rule.injectKind).toBe('header');
    expect(rule.injectName).toBe('X-API-Key');
  });

  it('accepts a valid query rule', () => {
    const rule = validateRule({ ...valid, injectKind: 'query', injectName: 'api_key' });
    expect(rule.injectKind).toBe('query');
  });

  it('uppercases methods', () => {
    const rule = validateRule({ ...valid, methods: ['get', 'post'] });
    expect(rule.methods).toEqual(['GET', 'POST']);
  });

  it('rejects non-https pattern', () => {
    expect(() => validateRule({ ...valid, pattern: 'http://api.example.com' }))
      .toThrow(AllowlistError);
  });

  it('rejects invalid URL pattern', () => {
    expect(() => validateRule({ ...valid, pattern: 'https://' }))
      .toThrow(AllowlistError);
  });

  it('rejects invalid injectKind', () => {
    expect(() => validateRule({ ...valid, injectKind: 'body' }))
      .toThrow(/injectKind must be one of/);
  });

  it('requires injectName for header kind', () => {
    expect(() => validateRule({ ...valid, injectKind: 'header', injectName: '' }))
      .toThrow(/injectName is required/);
  });

  it('requires secretName', () => {
    expect(() => validateRule({ ...valid, secretName: '' }))
      .toThrow(/secretName is required/);
  });

  it('rejects empty methods array', () => {
    expect(() => validateRule({ ...valid, methods: [] }))
      .toThrow(/non-empty array/);
  });

  it('rejects invalid HTTP method characters', () => {
    expect(() => validateRule({ ...valid, methods: ['GET', '123'] }))
      .toThrow(/invalid HTTP method/);
  });

  describe('oauth2_cc', () => {
    const oauth = {
      ...valid,
      injectKind: 'oauth2_cc',
      secretName2: 'CLIENT_SECRET',
      tokenUrl: 'https://auth.example.com/oauth/token',
    };

    it('accepts a valid oauth2_cc rule', () => {
      const rule = validateRule(oauth);
      expect(rule.injectKind).toBe('oauth2_cc');
      expect(rule.secretName2).toBe('CLIENT_SECRET');
      expect(rule.tokenUrl).toBe('https://auth.example.com/oauth/token');
    });

    it('requires secretName2 for oauth2_cc', () => {
      expect(() => validateRule({ ...oauth, secretName2: '' }))
        .toThrow(/client_secret.*required/i);
    });

    it('requires tokenUrl for oauth2_cc', () => {
      expect(() => validateRule({ ...oauth, tokenUrl: '' }))
        .toThrow(/tokenUrl is required/);
    });

    it('rejects non-https tokenUrl', () => {
      expect(() => validateRule({ ...oauth, tokenUrl: 'http://auth.example.com/token' }))
        .toThrow(/tokenUrl must start with https/);
    });

    it('blocks private/internal hosts in tokenUrl', () => {
      expect(() => validateRule({ ...oauth, tokenUrl: 'https://localhost/token' }))
        .toThrow(/private\/internal/);
      expect(() => validateRule({ ...oauth, tokenUrl: 'https://127.0.0.1/token' }))
        .toThrow(/private\/internal/);
      expect(() => validateRule({ ...oauth, tokenUrl: 'https://192.168.1.1/token' }))
        .toThrow(/private\/internal/);
      expect(() => validateRule({ ...oauth, tokenUrl: 'https://169.254.169.254/token' }))
        .toThrow(/private\/internal/);
    });
  });
});

describe('pickRule', () => {
  const rules: AllowlistRule[] = [
    { pattern: 'https://api.example.com/', injectKind: 'bearer', injectName: '', secretName: 'k1', secretName2: '', tokenUrl: '', methods: ['GET', 'POST'] },
    { pattern: 'https://api.example.com/v2/', injectKind: 'header', injectName: 'X-Key', secretName: 'k2', secretName2: '', tokenUrl: '', methods: ['GET'] },
  ];

  it('matches the longest prefix', () => {
    const rule = pickRule(rules, 'https://api.example.com/v2/users', 'GET');
    expect(rule?.secretName).toBe('k2');
  });

  it('falls back to shorter prefix when method not allowed on longer', () => {
    const rule = pickRule(rules, 'https://api.example.com/v2/users', 'POST');
    expect(rule?.secretName).toBe('k1');
  });

  it('returns null for no match', () => {
    expect(pickRule(rules, 'https://other.com/', 'GET')).toBeNull();
  });

  it('matches case-insensitively on method', () => {
    const rule = pickRule(rules, 'https://api.example.com/', 'get');
    expect(rule?.secretName).toBe('k1');
  });
});

describe('injectSecret', () => {
  const baseRule: AllowlistRule = {
    pattern: 'https://api.example.com/', injectKind: 'bearer',
    injectName: '', secretName: 'k', secretName2: '', tokenUrl: '', methods: ['GET'],
  };

  it('injects bearer token', () => {
    const { headers } = injectSecret(baseRule, 'https://api.example.com/data', new Headers(), 'tok123');
    expect(headers.get('Authorization')).toBe('Bearer tok123');
  });

  it('injects custom header', () => {
    const rule = { ...baseRule, injectKind: 'header' as const, injectName: 'X-API-Key' };
    const { headers } = injectSecret(rule, 'https://api.example.com/data', new Headers(), 'secret');
    expect(headers.get('X-API-Key')).toBe('secret');
  });

  it('injects query parameter', () => {
    const rule = { ...baseRule, injectKind: 'query' as const, injectName: 'key' };
    const { url } = injectSecret(rule, 'https://api.example.com/data', new Headers(), 'secret');
    expect(url).toContain('key=secret');
  });

  it('injects bearer for oauth2_cc', () => {
    const rule = { ...baseRule, injectKind: 'oauth2_cc' as const };
    const { headers } = injectSecret(rule, 'https://api.example.com/data', new Headers(), 'oauth-tok');
    expect(headers.get('Authorization')).toBe('Bearer oauth-tok');
  });
});

describe('isAiProviderHost', () => {
  // PAS has an empty blocklist (Pro developers can use any provider)
  it('returns false for any host on PAS (empty blocklist)', () => {
    expect(isAiProviderHost('api.openai.com')).toBe(false);
    expect(isAiProviderHost('api.anthropic.com')).toBe(false);
    expect(isAiProviderHost('api.example.com')).toBe(false);
  });
});
