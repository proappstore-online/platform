import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkPwaMeta } from './pwa-meta.js';

describe('checkPwaMeta', () => {
  it('passes with apple-mobile-web-app-capable', async () => {
    const files = new Map([
      [
        'web/index.html',
        '<html><head><meta name="apple-mobile-web-app-capable" content="yes" /></head></html>',
      ],
    ]);
    const r = await checkPwaMeta(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('passes with mobile-web-app-capable', async () => {
    const files = new Map([
      [
        'web/index.html',
        '<html><head><meta name="mobile-web-app-capable" content="yes" /></head></html>',
      ],
    ]);
    const r = await checkPwaMeta(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('warns when neither meta is present', async () => {
    const files = new Map([
      ['web/index.html', '<html lang="en"><head><title>x</title></head></html>'],
    ]);
    const r = await checkPwaMeta(mapFileSource(files));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/apple-mobile-web-app-capable/);
  });

  it('fails when index.html missing', async () => {
    const r = await checkPwaMeta(mapFileSource(new Map()));
    expect(r.status).toBe('fail');
  });

  it('does NOT count a meta tag inside an HTML comment as live', async () => {
    // A commented-out apple-mobile-web-app-capable tag isn't real and
    // shouldn't satisfy the check.
    const files = new Map([
      [
        'web/index.html',
        '<html><head><!-- <meta name="apple-mobile-web-app-capable" content="yes" /> --></head></html>',
      ],
    ]);
    const r = await checkPwaMeta(mapFileSource(files));
    expect(r.status).toBe('warn');
  });
});
