import { describe, expect, it } from 'vitest';
import { MAX_EMBED_ORIGINS, normaliseEmbedOrigin, validateEmbed } from './embed.js';

describe('normaliseEmbedOrigin (#453)', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['  https://Example.COM  ', 'https://example.com'],
    ['https://www.example.co.uk', 'https://www.example.co.uk'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['https://*.example.com', 'https://*.example.com'],
    ['https://*.Example.com:8443', 'https://*.example.com:8443'],
    ['https://partner.proappstore.online', 'https://partner.proappstore.online'],
    ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'],
  ])('accepts and normalises %s', (input, origin) => {
    expect(normaliseEmbedOrigin(input)).toEqual({ origin });
  });

  it.each([
    ['http://example.com', 'https origin'],
    ['example.com', 'https origin'],
    ['//example.com', 'https origin'],
    ['https://example.com/', 'https origin'],
    ['https://example.com/path', 'https origin'],
    ['https://example.com?x=1', 'https origin'],
    ['https://example.com#frag', 'https origin'],
    ['https://user@example.com', 'https origin'],
    ['https://exa mple.com', 'https origin'],
    ['https://example.com;script-src *', 'https origin'],
    ['https://example.com\n frame-ancestors *', 'https origin'],
    ['https://example.com, https://evil.com', 'https origin'],
    ["https://example.com' https://evil.com", 'https origin'],
    ['ftp://example.com', 'https origin'],
    ['*', 'https origin'],
    ['https://*', 'hostname'],
    ['https://*.com', 'wildcard'],
    ['https://*.*.example.com', 'wildcard'],
    ['https://a.*.example.com', 'hostname'],
    ['https://*example.com', 'hostname'],
    ['https://localhost', 'two labels'],
    ['https://127.0.0.1', 'IP address'],
    ['https://10.0.0.1:8080', 'IP address'],
    ['https://example.com:0', 'port'],
    ['https://example.com:99999', 'port'],
    ['https://-bad.example.com', 'hostname'],
    ['https://bücher.example', 'hostname'],
    ['https://example..com', 'hostname'],
  ])('refuses %s', (input, why) => {
    const r = normaliseEmbedOrigin(input);
    expect('error' in r, input).toBe(true);
    expect((r as { error: string }).error, input).toContain(why);
  });

  it('refuses a wildcard on a public suffix, a shared-hosting domain and the platform zone', () => {
    for (const bad of ['https://*.co.uk', 'https://*.com.au', 'https://*.github.io', 'https://*.pages.dev', 'https://*.vercel.app', 'https://*.notion.site']) {
      expect(normaliseEmbedOrigin(bad), bad).toMatchObject({ error: expect.stringContaining('would admit unrelated sites') });
    }
    for (const bad of ['https://*.proappstore.online', 'https://*.apps.proappstore.online']) {
      expect(normaliseEmbedOrigin(bad), bad).toMatchObject({ error: expect.stringContaining('would let any published app frame yours') });
    }
  });

  it('still allows naming one tenant of a shared-hosting domain exactly', () => {
    expect(normaliseEmbedOrigin('https://mysite.github.io')).toEqual({ origin: 'https://mysite.github.io' });
  });

  it('refuses a non-string and an over-long value', () => {
    expect(normaliseEmbedOrigin(5)).toEqual({ error: 'must be a string' });
    expect(normaliseEmbedOrigin(`https://${'a'.repeat(250)}.com`)).toMatchObject({ error: expect.stringContaining('253') });
  });
});

describe('validateEmbed (#453)', () => {
  it('treats absent, null and an empty list as no embedding', () => {
    expect(validateEmbed(undefined)).toEqual({ embed: null });
    expect(validateEmbed(null)).toEqual({ embed: null });
    expect(validateEmbed({ allow: [] })).toEqual({ embed: null });
  });

  it('accepts a list of origins, normalised, in order', () => {
    expect(validateEmbed({ allow: ['https://Example.com', 'https://*.partner.com'] }))
      .toEqual({ embed: { allow: ['https://example.com', 'https://*.partner.com'] } });
  });

  it(`accepts exactly ${MAX_EMBED_ORIGINS} origins and refuses one more`, () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `https://site${i}.example.com`);
    expect(validateEmbed({ allow: make(MAX_EMBED_ORIGINS) })).toMatchObject({ embed: { allow: expect.any(Array) } });
    expect(validateEmbed({ allow: make(MAX_EMBED_ORIGINS + 1) })).toEqual({ error: `embed.allow: at most ${MAX_EMBED_ORIGINS} origins` });
  });

  it('refuses the wrong shapes', () => {
    expect(validateEmbed('https://example.com')).toMatchObject({ error: expect.stringContaining('embed must be an object') });
    expect(validateEmbed(['https://example.com'])).toMatchObject({ error: expect.stringContaining('embed must be an object') });
    expect(validateEmbed({})).toMatchObject({ error: expect.stringContaining('embed.allow is required') });
    expect(validateEmbed({ allow: 'https://example.com' })).toEqual({ error: 'embed.allow must be an array of https origins' });
    expect(validateEmbed({ allow: ['https://example.com'], mode: 'all' })).toEqual({ error: 'embed: unknown field "mode"' });
  });

  it('names the offending entry', () => {
    expect(validateEmbed({ allow: ['https://ok.example.com', 'http://bad.example.com'] }))
      .toMatchObject({ error: expect.stringMatching(/^embed\.allow\[1\] must be an https origin/) });
  });

  it('refuses a duplicate after normalisation', () => {
    expect(validateEmbed({ allow: ['https://example.com', 'https://EXAMPLE.com'] }))
      .toEqual({ error: 'embed.allow[1]: duplicate origin https://example.com' });
  });
});
