import { describe, expect, it } from 'vitest';
import { buildLoaderJs } from './analytics.js';
import { testToken, TEST_SK } from '../test-helpers.js';
import { registerStatsRoutes } from './analytics-stats-routes.js';

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

describe('Analytics stats routes — CF Analytics SQL syntax (#290, #289)', () => {
  it('uses valid Cloudflare Analytics Engine SQL syntax with CAST(doubles[2] AS Int64)', () => {
    // Regression test for #290/#289: toInt64() is not a valid CF Analytics function.
    // The correct syntax is CAST(doubles[2] AS Int64) with proper array indexing.
    // This ensures the effectiveTime expression in stats queries doesn't use invalid functions.
    const analyticsRoutesFile = require('fs').readFileSync(
      require('path').join(__dirname, 'analytics-stats-routes.ts'),
      'utf-8',
    );
    expect(analyticsRoutesFile).toContain('CAST(doubles[2] AS Int64)');
    expect(analyticsRoutesFile).not.toContain('toInt64(double2)');
    expect(analyticsRoutesFile).not.toContain('toInt64(');
  });

  it('stats route SQL queries generate correct timestamp conversion expressions', () => {
    // Verify that the effectiveTime expression uses correct ClickHouse syntax:
    // - Uses CAST for type conversion (not the non-existent toInt64 function)
    // - Uses proper array indexing doubles[2] (not double2)
    // - Falls back to server timestamp when client timestamp is absent
    const analyticsRoutesFile = require('fs').readFileSync(
      require('path').join(__dirname, 'analytics-stats-routes.ts'),
      'utf-8',
    );
    const effectiveTimeExpr = 'if(length(doubles) > 1, fromUnixTimestamp64Milli(CAST(doubles[2] AS Int64)), timestamp)';
    expect(analyticsRoutesFile).toContain(effectiveTimeExpr);
    // Count occurrences in stats queries (should be 3: stats, events, platform admin)
    const matches = analyticsRoutesFile.match(/CAST\(doubles\[2\] AS Int64\)/g);
    expect(matches?.length).toBe(3);
  });
});
