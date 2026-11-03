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
import { INITIAL_LOAD_MAX_GZIP_BYTES, LAZY_ASSET_MAX_BYTES } from '../lib/bundle-limits.js';
import type { FileSource } from '../lib/file-source.js';
import { gzipByteLength } from '../lib/gzip.js';
import { collectInitialJsRefs, jsAssetFileName, safePath } from '../lib/html-initial-js.js';
// Pure JavaScript lexer: synchronous, no WASM initialization or runtime fetch (#532).
import { parse } from 'es-module-lexer/js';
import type { CheckResult } from '../types.js';


const ASSETS_DIR = 'web/dist/assets';
const DIST_HTML = 'web/dist/index.html';
const VITE_MANIFEST = 'web/dist/.vite/manifest.json';

const INITIAL_SUGGESTIONS = [
  'Find heavy dependencies: `pnpm dlx vite-bundle-visualizer`',
  'Lazy-load non-critical screens with dynamic import().',
  'Consider lighter alternatives for the biggest deps.',
];

const LAZY_SUGGESTIONS = [
  'Split or compress this lazy asset, or ship a smaller language pack / model.',
  'Keep the heavy file behind dynamic import() / new Worker() / new URL(..., import.meta.url).',
];

/** File names under assets/ that count as JS (entry, chunks, workers). */
function isJsAsset(name: string): boolean {
  return /\.(?:m|c)?js$/i.test(name);
}

/**
 * Lazy code/data that gets the 25 MB cap. Images, fonts, CSS and source
 * maps are not this check's job.
 */
function isLazyCappedAsset(name: string): boolean {
  if (/\.map$/i.test(name)) return false;
  return isJsAsset(name) || /\.(?:wasm|data|bin|onnx|ort|tflite|gguf|safetensors|pt|pth|traineddata|gz|zst)$/i.test(name);
}

export interface BundleSizeOptions {
  /** Override the 300 KB gzip initial-load cap. Tests only. */
  initialMaxGzipBytes?: number;
  /** Override the 25 MB lazy-asset cap. Tests only. */
  lazyMaxBytes?: number;
}

/**
 * Caps the JS the browser downloads on first paint, and separately caps
 * lazily loaded wasm / workers / dynamic chunks.
 *
 * Initial load is the HTML entry plus its static imports (from the Vite
 * manifest when present, otherwise from `<script>` / `modulepreload` plus
 * a walk of static `import` statements). Dynamically imported chunks,
 * workers, `.wasm` and data files are not in that graph: they get a much
 * larger per-asset cap and are reported as info when under it.
 *
 * Returns `warn` if dist hasn't been built yet — we don't want to silently
 * pass when there's nothing to measure.
 *
 * Uses the Web `CompressionStream('gzip')` API rather than `node:zlib` so
 * the same module loads in Cloudflare Workers (the VibeCode agent
 * bundles this package). The agent will always hit the "not built yet"
 * branch since the virtual filesystem holds source, not artefacts.
 */
export async function checkBundleSize(
  source: FileSource,
  opts: BundleSizeOptions = {},
): Promise<CheckResult> {
  const initialMax = opts.initialMaxGzipBytes ?? INITIAL_LOAD_MAX_GZIP_BYTES;
  const lazyMax = opts.lazyMaxBytes ?? LAZY_ASSET_MAX_BYTES;

  if (!source.listDir) {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: 'file source does not support directory listing',
    };
  }
  let entries: string[] | null;
  try { entries = await listAssets(source); } catch (e) { return invalidBuild(e); }
  if (entries === null) {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: 'web/dist not built yet — run `pnpm build` to measure',
    };
  }

  const jsFiles = entries.filter(isJsAsset);
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

  let initialJs: Set<string>;
  let measured: { name: string; gzipped: number };
  try {
    initialJs = await resolveInitialJs(source, jsFiles);
    measured = await measureInitialGzip(source, initialJs);
  } catch (e) { return invalidBuild(e); }

  const lazyOver: { name: string; bytes: number }[] = [];
  let lazyLargest: { name: string; bytes: number } | null = null;
  for (const f of entries) {
    if (initialJs.has(f)) continue;
    if (!isLazyCappedAsset(f)) continue;
    let bytes: Uint8Array | null;
    try { bytes = await source.readBytes(`${ASSETS_DIR}/${f}`); } catch (e) { return invalidBuild(e); }
    if (!bytes) return invalidBuild(new Error(`Cannot read lazy asset ${f}`));
    const size = bytes.byteLength;
    if (!lazyLargest || size > lazyLargest.bytes) lazyLargest = { name: f, bytes: size };
    if (size > lazyMax) lazyOver.push({ name: f, bytes: size });
  }

  const limitKb = (initialMax / 1024).toFixed(0);
  const lazyLimitLabel = formatCap(lazyMax);
  const issues: string[] = [];
  const suggestions: string[] = [];

  if (measured.gzipped > initialMax) {
    issues.push(`${measured.name}: ${formatKb(measured.gzipped)} KB gzipped (limit ${limitKb} KB)`);
    suggestions.push(...INITIAL_SUGGESTIONS);
  }
  for (const over of lazyOver) {
    issues.push(`${over.name}: ${formatSize(over.bytes)} (limit ${lazyLimitLabel} per lazy asset)`);
  }
  if (lazyOver.length > 0) suggestions.push(...LAZY_SUGGESTIONS);

  if (issues.length > 0) {
    return { name: 'Bundle size', status: 'fail', detail: issues.join('; '), suggestions };
  }

  let detail = `${measured.name}: ${formatKb(measured.gzipped)} KB gzipped (limit ${limitKb} KB)`;
  if (lazyLargest) {
    detail += `; lazy ${lazyLargest.name} ${formatSize(lazyLargest.bytes)} (limit ${lazyLimitLabel})`;
  }
  return { name: 'Bundle size', status: 'pass', detail };
}

function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

/** Human size for a lazy asset. Sub-megabyte files stay in KB so a 400 KB
 *  chunk is not reported as 0.0 MB. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatCap(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  return formatSize(bytes);
}

async function measureInitialGzip(
  source: FileSource,
  files: Set<string>,
): Promise<{ name: string; gzipped: number }> {
  let gzipped = 0;
  for (const f of files) {
    const content = await source.readBytes?.(`${ASSETS_DIR}/${f}`);
    if (!content) throw new Error(`Cannot read initial asset ${f}`);
    gzipped += await gzipByteLength(content);
  }
  return { name: `initial JS total (${files.size} files: ${[...files].sort().join(', ')})`, gzipped };
}

function invalidBuild(error: unknown): CheckResult {
  return { name: 'Bundle size', status: 'fail', detail: `Cannot measure build: ${error instanceof Error ? error.message : String(error)}`,
    suggestions: ['Rebuild web/dist with valid asset paths and a current Vite manifest.'] };
}

/** Bounded recursion supports custom nested Vite asset names without escaping assets/. */
async function listAssets(source: FileSource): Promise<string[] | null> {
  const root = await source.listDir!(ASSETS_DIR);
  if (root === null) return null;
  const files: string[] = [];
  let visited = 0;
  async function walk(entries: string[], prefix: string, depth: number): Promise<void> {
    if (depth > 16) throw new Error('Asset directory nesting exceeds 16 levels');
    for (const name of entries) {
      if (++visited > 10_000) throw new Error('Asset directory exceeds 10,000 entries');
      if (!safePath(name) || name.includes('/')) throw new Error('Invalid asset directory entry');
      const relative = prefix + name;
      if (isLazyCappedAsset(name) || /\.(?:css|map|woff2?|png|svg|ico|jpe?g|webp)$/i.test(name)) {
        files.push(relative);
      } else {
        const children = await source.listDir!(`${ASSETS_DIR}/${relative}`);
        if (children !== null) await walk(children, `${relative}/`, depth + 1);
      }
    }
  }
  await walk(root, '', 0);
  return files;
}

/**
 * Files in the initial-load JS graph. Prefer the Vite manifest (HTML
 * entries + static `imports`, never `dynamicImports` or worker entries).
 * Fall back to index.html + a walk of static ESM imports. If neither
 * exists, every JS asset is treated as initial — a conservative fallback, so a missing HTML can't silently ignore a huge
 * bundle.
 */
async function resolveInitialJs(source: FileSource, jsFiles: string[]): Promise<Set<string>> {
  const fromManifest = await initialJsFromViteManifest(source);
  const fromHtml = await initialJsFromHtml(source);
  const roots = new Set([...(fromManifest ?? []), ...(fromHtml ?? [])]);
  if (roots.size === 0) return new Set(jsFiles);
  // Also walk actual JS: a stale manifest must not hide a new static import.
  const initial = await followStaticImports(source, roots);
  const known = new Set(jsFiles);
  for (const name of initial) {
    if (!known.has(name)) throw new Error(`Initial asset missing from build: ${name}`);
  }
  return initial;
}

interface ViteChunk {
  file?: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

async function initialJsFromViteManifest(source: FileSource): Promise<Set<string> | null> {
  const raw = await source.read(VITE_MANIFEST);
  if (raw === null) return null;
  let manifest: Record<string, ViteChunk>;
  try {
    manifest = JSON.parse(raw) as Record<string, ViteChunk>;
  } catch {
    throw new Error('Invalid Vite manifest JSON');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid Vite manifest object');

  const queue: string[] = [];
  for (const [key, chunk] of Object.entries(manifest)) {
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk) ||
        (chunk.file !== undefined && (typeof chunk.file !== 'string' || !safePath(chunk.file.replace(/^\.\//, '')))) ||
        (chunk.src !== undefined && typeof chunk.src !== 'string') ||
        (chunk.imports !== undefined && (!Array.isArray(chunk.imports) || !chunk.imports.every((x) => typeof x === 'string'))) ||
        (chunk.dynamicImports !== undefined && (!Array.isArray(chunk.dynamicImports) || !chunk.dynamicImports.every((x) => typeof x === 'string'))) ||
        (chunk.isDynamicEntry !== undefined && typeof chunk.isDynamicEntry !== 'boolean') ||
        (chunk.isEntry !== undefined && typeof chunk.isEntry !== 'boolean')) {
      throw new Error('Invalid Vite manifest chunk');
    }
    if (!chunk.isEntry) continue;
    if (key.endsWith('.html') || chunk.src?.endsWith('.html')) queue.push(key);
  }
  if (queue.length === 0) return null;

  const initial = new Set<string>();
  const visited = new Set<string>();
  while (queue.length > 0) {
    const key = queue.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const chunk = Object.hasOwn(manifest, key) ? manifest[key] : undefined;
    if (!chunk) throw new Error('Vite manifest references a missing chunk');
    const asset = distAssetName(chunk.file);
    if (chunk.file && isJsAsset(chunk.file) && !asset) throw new Error('Initial JavaScript must be emitted under assets/');
    if (asset && isJsAsset(asset)) initial.add(asset);
    for (const imp of chunk.imports ?? []) queue.push(imp);
  }
  return initial;
}

function distAssetName(file: string | undefined): string | null {
  if (!file) return null;
  const normalized = file.replace(/^\.\//, '');
  if (normalized.startsWith('assets/')) return normalized.slice('assets/'.length);
  return null;
}

async function initialJsFromHtml(source: FileSource): Promise<Set<string> | null> {
  const html = await source.read(DIST_HTML);
  if (!html) return null;
  const names = new Set<string>();
  for (const ref of collectInitialJsRefs(html)) {
    const name = jsAssetFileName(ref);
    if (name) names.add(name);
    else throw new Error('Cannot measure initial JavaScript outside local assets/: bundle remote or unsupported script paths locally');
  }
  return names.size > 0 ? names : null;
}

async function followStaticImports(source: FileSource, roots: Set<string>): Promise<Set<string>> {
  const out = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (out.has(file)) continue;
    out.add(file);
    const text = await readText(source, `${ASSETS_DIR}/${file}`);
    if (text === null) throw new Error(`Cannot read initial asset ${file}`);
    for (const spec of staticImportSpecs(text)) {
      const localRelative = spec.startsWith('./') || spec.startsWith('../');
      const localAbsolute = spec.startsWith('/') && !spec.startsWith('//');
      if (!localRelative && !localAbsolute) throw new Error('Cannot measure remote or bare static imports; bundle dependencies locally');
      const path = spec.split(/[?#]/, 1)[0]!;
      if (!isJsAsset(path)) {
        // Native non-JS modules are outside the JavaScript budget. Unknown
        // extensions may still be JavaScript and must not silently pass.
        if (/\.(?:json|css|wasm)$/i.test(path)) continue;
        throw new Error('Unsupported static JavaScript asset extension');
      }
      const resolved = localRelative ? resolveRelative(file, spec) : jsAssetFileName(spec);
      if (!resolved) throw new Error('Invalid absolute static JavaScript path');
      if (resolved && !out.has(resolved)) queue.push(resolved);
    }
  }
  return out;
}

/** Lex valid ESM syntax, including escaped names and multiline re-exports.
 * Dynamic imports and import.meta are deliberately excluded from eager loading. */
function staticImportSpecs(js: string): string[] {
  const [imports] = parse(js);
  return imports.filter((entry) => entry.d === -1).map((entry) => {
    if (entry.n === undefined) throw new Error('Cannot resolve static JavaScript import');
    return entry.n;
  });
}

function resolveRelative(fromFile: string, spec: string): string {
  const path = spec.split(/[?#]/, 1)[0]!;
  const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const parts = [...(fromDir ? fromDir.split('/') : []), ...path.split('/')];
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') {
      if (out.length === 0) throw new Error('Static import escapes assets/');
      out.pop();
    }
    else out.push(p);
  }
  const resolved = out.join('/');
  if (!safePath(resolved)) throw new Error('Invalid static import path');
  return resolved;
}

async function readText(source: FileSource, path: string): Promise<string | null> {
  const text = await source.read(path);
  if (text !== null) return text;
  const bytes = await source.readBytes?.(path);
  if (!bytes) return null;
  return new TextDecoder().decode(bytes);
}
