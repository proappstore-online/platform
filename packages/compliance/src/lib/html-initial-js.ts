/*!
MIT License

Copyright (c) 2026 FreeAppStore

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Adapted from freeappstore-online/platform at 57a9fef25b5ef47087b03ce770ba457dabfbabe1.
// Copyright (c) 2026 FreeAppStore. MIT; see lib/bundle-limits.LICENSE.
// PAS #523: aggregate initial budget and validated asset paths/manifest shapes.
/**
 * Pull the JS URLs the browser fetches from the initial HTML parse:
 * `<script src>` and `<link rel="modulepreload">`. Dynamically imported
 * chunks, workers and wasm do not appear here — Vite only modulepreloads
 * the static import graph.
 */

const JS_REF_RE = /\.(?:m|c)?js(?:[?#]|$)/i;

export function collectInitialJsRefs(html: string): string[] {
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (ref: string | undefined) => {
    if (!ref) return;
    const trimmed = ref.trim();
    if (!trimmed || seen.has(trimmed) || !JS_REF_RE.test(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    add(getAttr(m[0]!, 'src'));
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = getAttr(m[0]!, 'rel');
    if (rel?.toLowerCase().split(/\s+/).includes('modulepreload')) add(getAttr(m[0]!, 'href'));
  }
  return out;
}

/**
 * Map a script/modulepreload URL to a file name under `web/dist/assets/`.
 * `null` if the ref is not an `/assets/*.js` (or `.mjs`) path.
 */
export function jsAssetFileName(ref: string): string | null {
  // External URLs are not local build files; never interpret their pathname as one.
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(ref)) return null;
  const path = ref.split(/[?#]/, 1)[0]!.replace(/^\.\//, '');
  const m = /^(?:\/)?(?:[^/]+\/)*assets\/(.+\.(?:m|c)?js)$/i.exec(path);
  if (!m || !safePath(path.replace(/^\//, '')) || !safePath(m[1]!)) return null;
  return m[1]!;
}

/** Asset names are relative POSIX paths. Reject encoded separators/traversal as well. */
export function safePath(path: string): boolean {
  if (!path || /[\\\x00-\x1f:%?#]/.test(path) || path.startsWith('/')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function getAttr(tag: string, name: string): string | undefined {
  // Require a real attribute boundary. `\b` would also match `data-src`.
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}
