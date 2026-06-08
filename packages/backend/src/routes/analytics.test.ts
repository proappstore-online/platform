import { describe, expect, it } from 'vitest';
import { buildLoaderJs } from './analytics.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1');

const empty = {
  cf_beacon_token: null,
  ga4: null,
  plausible: null,
  custom_head: null,
  updated_at: null,
};

describe('buildLoaderJs (PAS)', () => {
  it('always emits the first-party page-view beacon', () => {
    const js = buildLoaderJs(null, 'myapp');
    expect(js).toContain('/v1/analytics/event');
    expect(js).toContain('sendBeacon');
    expect(js).toContain('window.pasAnalytics');
  });

  it('emits the CF Web Analytics beacon when cf_beacon_token is set', () => {
    const js = buildLoaderJs(
      { ...empty, cf_beacon_token: 'abc123abc123abc123abc123abc123ab' },
      'myapp',
    );
    expect(js).toContain('static.cloudflareinsights.com/beacon.min.js');
    expect(js).toContain('abc123abc123abc123abc123abc123ab');
  });

  it('rejects malformed tokens / ids (tags dropped but first-party beacon stays)', () => {
    expect(buildLoaderJs({ ...empty, ga4: 'UA-1234' }, 'myapp')).not.toContain('googletagmanager');
    expect(buildLoaderJs({ ...empty, plausible: 'not a domain' }, 'myapp')).not.toContain(
      'plausible.io',
    );
    expect(buildLoaderJs({ ...empty, cf_beacon_token: 'not-hex' }, 'myapp')).not.toContain(
      'static.cloudflareinsights',
    );
  });

  it('emits GA4, Plausible, custom_head when valid', () => {
    const js = buildLoaderJs(
      {
        ...empty,
        ga4: 'G-ABC123',
        plausible: 'mysite.com',
        custom_head: '<meta name="x" content="y" />',
      },
      'myapp',
    );
    expect(js).toContain('googletagmanager.com/gtag/js?id=');
    expect(js).toContain('plausible.io/js/script.js');
    expect(js).toContain('mysite.com');
    expect(js).toContain('<meta name=\\"x\\"');
  });
});
