import type { FileSource } from '../lib/file-source.js';
import { stripHtmlComments } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

const HTML_PATH = 'web/index.html';

/**
 * For an "Add to Home Screen" install on iOS Safari to launch the app
 * standalone (no browser chrome), `web/index.html` needs at least one
 * of:
 *
 *   <meta name="apple-mobile-web-app-capable" content="yes" />
 *   <meta name="mobile-web-app-capable" content="yes" />
 *
 * Without this, iOS opens the installed icon as a normal Safari tab,
 * defeating the PWA install. Android Chrome reads the manifest's
 * `display: standalone` instead, but iOS still requires the meta tag.
 *
 * The manifest itself is a separate check (`checkManifest`); this one
 * is specifically the iOS install hint that lives in the HTML head.
 */
export async function checkPwaMeta(source: FileSource): Promise<CheckResult> {
  const rawHtml = await source.read(HTML_PATH);
  if (rawHtml === null) {
    return {
      name: 'PWA meta tags',
      status: 'fail',
      detail: `${HTML_PATH} not found`,
    };
  }
  // Strip HTML comments — `<!-- <meta name="apple-mobile-web-app-capable"> -->`
  // doesn't tell iOS anything.
  const html = stripHtmlComments(rawHtml);
  if (/<meta[^>]*\bname\s*=\s*["'](?:apple-)?mobile-web-app-capable["']/i.test(html)) {
    return { name: 'PWA meta tags', status: 'pass', detail: 'iOS install hint present' };
  }
  return {
    name: 'PWA meta tags',
    status: 'warn',
    detail: 'no apple-mobile-web-app-capable / mobile-web-app-capable meta',
    suggestions: [
      'Add `<meta name="apple-mobile-web-app-capable" content="yes" />` to <head> so iOS installs launch standalone.',
    ],
  };
}
