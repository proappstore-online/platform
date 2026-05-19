import type { FileSource } from '../lib/file-source.js';
import { gzipByteLength } from '../lib/gzip.js';
import type { CheckResult } from '../types.js';

const MAX_GZIP_BYTES = 300 * 1024; // 300 KB — matches the template's compliance.yml
const ASSETS_DIR = 'web/dist/assets';

/**
 * Checks the largest JS asset under web/dist/assets/ against the 300KB-gzip
 * limit. Returns 'warn' if dist hasn't been built yet (we don't want to
 * silently pass when there's nothing to measure).
 *
 * Uses the Web `CompressionStream('gzip')` API rather than `node:zlib` so
 * the same module loads in Cloudflare Workers (the VibeCode agent
 * bundles this package). The agent will always hit the "not built yet"
 * branch since the virtual filesystem holds source, not artefacts.
 */
export async function checkBundleSize(source: FileSource): Promise<CheckResult> {
  if (!source.listDir) {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: 'file source does not support directory listing',
    };
  }
  const entries = await source.listDir(ASSETS_DIR);
  if (entries === null) {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: 'web/dist not built yet — run `pnpm build` to measure',
    };
  }

  const jsFiles = entries.filter((f) => f.endsWith('.js'));
  if (jsFiles.length === 0) {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: `no JS files in ${ASSETS_DIR}`,
    };
  }

  if (!source.readBytes) {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: 'file source does not support binary reads',
    };
  }

  // Find the largest JS file (the entry chunk) — same behavior as the
  // existing compliance.yml in the templates.
  let largest = '';
  let largestSize = 0;
  for (const f of jsFiles) {
    const bytes = await source.readBytes(`${ASSETS_DIR}/${f}`);
    if (bytes && bytes.byteLength > largestSize) {
      largest = f;
      largestSize = bytes.byteLength;
    }
  }
  if (!largest) {
    return { name: 'Bundle size', status: 'warn', detail: `no readable JS in ${ASSETS_DIR}` };
  }

  const content = await source.readBytes(`${ASSETS_DIR}/${largest}`);
  if (!content) {
    return { name: 'Bundle size', status: 'warn', detail: `could not read ${largest}` };
  }
  const gzipped = await gzipByteLength(content);
  const kb = (gzipped / 1024).toFixed(1);
  const limitKb = (MAX_GZIP_BYTES / 1024).toFixed(0);

  if (gzipped > MAX_GZIP_BYTES) {
    return {
      name: 'Bundle size',
      status: 'fail',
      detail: `${largest}: ${kb} KB gzipped (limit ${limitKb} KB)`,
      suggestions: [
        'Find heavy dependencies: `pnpm dlx vite-bundle-visualizer`',
        'Lazy-load non-critical screens with dynamic import().',
        'Consider lighter alternatives for the biggest deps.',
      ],
    };
  }

  return {
    name: 'Bundle size',
    status: 'pass',
    detail: `${largest}: ${kb} KB gzipped (limit ${limitKb} KB)`,
  };
}
