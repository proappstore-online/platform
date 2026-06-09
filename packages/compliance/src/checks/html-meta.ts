import type { FileSource } from '../lib/file-source.js';
import { stripHtmlComments } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

const HTML_PATH = 'web/index.html';

/**
 * Verifies `web/index.html` declares the basics: a `lang` attribute, a
 * viewport meta, a non-empty `<title>`, and shared-link preview images.
 * These together cover:
 *
 *   - lang   → screen readers + auto-translate work correctly
 *   - viewport → mobile rendering is sized to device, not desktop default
 *   - title  → the only thing visible in tabs, history, search results
 *   - preview images → the app URL shares with the app's own visual identity
 *
 * These fields are baked into the canonical template — this check exists
 * to catch creators who edited index.html and accidentally stripped
 * something they needed.
 */
export async function checkHtmlMeta(source: FileSource): Promise<CheckResult> {
  const rawHtml = await source.read(HTML_PATH);
  if (rawHtml === null) {
    return {
      name: 'HTML meta tags',
      status: 'fail',
      detail: `${HTML_PATH} not found`,
    };
  }
  // Strip HTML comment bodies before matching — `<!-- <meta name=
  // "viewport" ...> -->` is not a real viewport meta, and a commented-
  // out `<title>` shouldn't count either.
  const html = stripHtmlComments(rawHtml);

  const missing: string[] = [];
  if (!/<html[^>]*\blang\s*=/i.test(html)) missing.push('lang attribute on <html>');
  if (!/<meta[^>]*\bname\s*=\s*["']viewport["']/i.test(html)) missing.push('viewport meta');
  // Extract the <title> body (multiline-safe), trim, and require it
  // be non-empty. Avoids rejecting valid titles like `<title> Hello</title>`
  // where the body has leading whitespace.
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!titleMatch || titleMatch[1]!.trim() === '') missing.push('non-empty <title>');
  if (!/<meta[^>]*\bproperty\s*=\s*["']og:image["'][^>]*\bcontent\s*=/i.test(html)) missing.push('og:image');
  if (!/<meta[^>]*\bname\s*=\s*["']twitter:image["'][^>]*\bcontent\s*=/i.test(html)) missing.push('twitter:image');

  if (missing.length === 0) {
    return { name: 'HTML meta tags', status: 'pass', detail: 'lang + viewport + title + share images present' };
  }
  return {
    name: 'HTML meta tags',
    status: 'fail',
    detail: `missing: ${missing.join(', ')}`,
    suggestions: [
      'Restore the canonical <head>: `<html lang="en">`, viewport, title, and `og:image` / `twitter:image` pointing at `/og-image.png`.',
    ],
  };
}
