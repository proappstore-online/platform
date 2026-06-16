import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-ESM container helper (runs in the Docker image as JS).
import { locateDist, r2Destination, isValidAppId, isValidSha, parseJob, cloneUrl } from './lib.mjs';

describe('builder/lib — layout detection', () => {
  it('prefers web/dist when present (web/ sub-package)', () => {
    expect(locateDist((p: string) => p === 'web/dist' || p === 'dist')).toBe('web/dist');
  });
  it('falls back to dist (flat app)', () => {
    expect(locateDist((p: string) => p === 'dist')).toBe('dist');
  });
  it('throws when neither exists', () => {
    expect(() => locateDist(() => false)).toThrow(/No build output/);
  });
});

describe('builder/lib — R2 destination', () => {
  it('builds the canonical apps/<id>/ path the host worker serves', () => {
    expect(r2Destination('pas-apps', 'clean-up')).toBe('s3://pas-apps/apps/clean-up/');
  });
  it('rejects an invalid appId (path-injection guard)', () => {
    expect(() => r2Destination('pas-apps', '../evil')).toThrow(/invalid appId/);
  });
  it('requires a bucket', () => {
    expect(() => r2Destination('', 'x')).toThrow(/bucket is required/);
  });
});

describe('builder/lib — validators', () => {
  it('appId: lowercase/digits/hyphens, starts with a letter, ≤58', () => {
    expect(isValidAppId('chess-academy')).toBe(true);
    expect(isValidAppId('1bad')).toBe(false);
    expect(isValidAppId('UPPER')).toBe(false);
    expect(isValidAppId('a'.repeat(59))).toBe(false);
  });
  it('sha: exactly 40 hex', () => {
    expect(isValidSha('a'.repeat(40))).toBe(true);
    expect(isValidSha('abc')).toBe(false);
    expect(isValidSha('g'.repeat(40))).toBe(false);
  });
});

describe('builder/lib — parseJob', () => {
  const good = {
    BUILD_REPO: 'proappstore-online/clean-up',
    BUILD_SHA: 'a'.repeat(40),
    BUILD_APP_ID: 'clean-up',
  };
  it('accepts a valid job and defaults the bucket', () => {
    const job = parseJob(good);
    expect(job).toMatchObject({
      repo: 'proappstore-online/clean-up',
      appId: 'clean-up',
      bucket: 'pas-apps',
      destination: 's3://pas-apps/apps/clean-up/',
    });
  });
  it('rejects a missing/invalid sha', () => {
    expect(() => parseJob({ ...good, BUILD_SHA: 'nope' })).toThrow(/BUILD_SHA/);
  });
  it('rejects a malformed repo', () => {
    expect(() => parseJob({ ...good, BUILD_REPO: 'noslash' })).toThrow(/BUILD_REPO/);
  });
  it('rejects an invalid appId', () => {
    expect(() => parseJob({ ...good, BUILD_APP_ID: '../x' })).toThrow(/BUILD_APP_ID/);
  });
});

describe('builder/lib — cloneUrl', () => {
  it('embeds the installation token for a one-shot authenticated clone', () => {
    expect(cloneUrl('proappstore-online/clean-up', 'ghs_xyz')).toBe(
      'https://x-access-token:ghs_xyz@github.com/proappstore-online/clean-up.git',
    );
  });
  it('refuses to build a URL without a token', () => {
    expect(() => cloneUrl('o/r', '')).toThrow(/token is required/);
  });
});
