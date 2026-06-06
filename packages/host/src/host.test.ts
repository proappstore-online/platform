import { describe, expect, it } from 'vitest';
import { slugFromHostname, r2KeyFor, etagsMatch, contentType, securityHeaders, type Route } from './host.js';

const route: Route = { slug: 'meetup', zone: 'proappstore.online', r2_prefix: 'apps/meetup', store: 'pas' };

describe('slugFromHostname', () => {
  it('extracts slug from subdomain', () => {
    expect(slugFromHostname('meetup.proappstore.online')).toBe('meetup');
    expect(slugFromHostname('chess-academy.proappstore.online')).toBe('chess-academy');
  });

  it('returns null for apex', () => {
    expect(slugFromHostname('proappstore.online')).toBeNull();
  });

  it('returns null for multi-level subdomain', () => {
    expect(slugFromHostname('a.b.proappstore.online')).toBeNull();
  });

  it('returns null for non-proappstore host', () => {
    expect(slugFromHostname('meetup.example.com')).toBeNull();
  });

  it('strips port', () => {
    expect(slugFromHostname('meetup.proappstore.online:8787')).toBe('meetup');
  });

  it('is case-insensitive', () => {
    expect(slugFromHostname('MeetUp.ProAppStore.Online')).toBe('meetup');
  });
});

describe('r2KeyFor', () => {
  it('maps root to index.html', () => {
    expect(r2KeyFor(route, '/')).toBe('apps/meetup/index.html');
    expect(r2KeyFor(route, '')).toBe('apps/meetup/index.html');
  });

  it('maps directory paths to index.html', () => {
    expect(r2KeyFor(route, '/about/')).toBe('apps/meetup/about/index.html');
  });

  it('maps file paths directly', () => {
    expect(r2KeyFor(route, '/assets/main.js')).toBe('apps/meetup/assets/main.js');
  });

  it('strips leading slashes', () => {
    expect(r2KeyFor(route, '///style.css')).toBe('apps/meetup/style.css');
  });
});

describe('etagsMatch', () => {
  it('returns false for null header', () => {
    expect(etagsMatch(null, '"abc"')).toBe(false);
  });

  it('matches wildcard', () => {
    expect(etagsMatch('*', '"abc"')).toBe(true);
  });

  it('matches exact etag', () => {
    expect(etagsMatch('"abc"', '"abc"')).toBe(true);
  });

  it('matches one of multiple etags', () => {
    expect(etagsMatch('"x", "abc", "y"', '"abc"')).toBe(true);
  });

  it('rejects non-matching etag', () => {
    expect(etagsMatch('"different"', '"abc"')).toBe(false);
  });
});

describe('contentType', () => {
  it('returns correct MIME for common extensions', () => {
    expect(contentType('main.js')).toBe('application/javascript; charset=utf-8');
    expect(contentType('style.css')).toBe('text/css; charset=utf-8');
    expect(contentType('index.html')).toBe('text/html; charset=utf-8');
    expect(contentType('data.json')).toBe('application/json; charset=utf-8');
    expect(contentType('logo.png')).toBe('image/png');
    expect(contentType('photo.webp')).toBe('image/webp');
    expect(contentType('font.woff2')).toBe('font/woff2');
    expect(contentType('icon.svg')).toBe('image/svg+xml');
    expect(contentType('manifest.webmanifest')).toBe('application/manifest+json');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(contentType('file.xyz')).toBe('application/octet-stream');
    expect(contentType('noext')).toBe('application/octet-stream');
  });
});

describe('securityHeaders', () => {
  it('sets CSP, XCTO, XFO, referrer policy for HTML', () => {
    const h = securityHeaders(true);
    expect(h.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(h.get('Content-Security-Policy')).toContain('api.proappstore.online');
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
    expect(h.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(h.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('sets short cache for HTML', () => {
    expect(securityHeaders(true).get('Cache-Control')).toContain('max-age=60');
  });

  it('sets immutable cache for assets', () => {
    expect(securityHeaders(false).get('Cache-Control')).toContain('immutable');
  });
});
