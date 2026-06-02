import type { FileSource } from '../lib/file-source.js';
import { extOf } from './pwa-offline-workbox.js';

/**
 * Walks web/public/ (one level deep is enough — workbox precache
 * resolves the pattern recursively, but most public assets sit at the
 * top level or one level down), returns extensions not in `covered`.
 * Ignores the manifest icons and favicons we already know are listed.
 */
export async function findUncoveredAssets(
  source: FileSource,
  dir: string,
  covered: Set<string>,
): Promise<string[]> {
  if (!source.listDir) return [];
  const seen = new Set<string>();
  await walkPublic(source, dir, seen, covered, 0);
  return [...seen].sort();
}

/**
 * Best-effort scan of web/src/ entry points for a manual
 * `serviceWorker.register` call. Doesn't recurse into the whole src
 * tree — we only care about top-level entry files (main, index,
 * registerSW) where this conventionally lives.
 */
export async function sourceHasSwRegistration(source: FileSource): Promise<boolean> {
  const candidates = [
    'web/src/main.tsx',
    'web/src/main.ts',
    'web/src/index.tsx',
    'web/src/index.ts',
    'web/src/registerSW.ts',
    'web/src/registerSW.js',
  ];
  for (const p of candidates) {
    const text = await source.read(p);
    if (text !== null && /serviceWorker\.register/.test(text)) return true;
  }
  return false;
}

async function walkPublic(
  source: FileSource,
  dir: string,
  seen: Set<string>,
  covered: Set<string>,
  depth: number,
): Promise<void> {
  if (depth > 3) return;
  if (!source.listDir) return;
  const entries = await source.listDir(dir);
  if (entries === null) return;
  for (const name of entries) {
    const full = `${dir}/${name}`;
    if (name.includes('.')) {
      const ext = extOf(name);
      if (!ext || covered.has(ext)) continue;
      seen.add(name);
    } else {
      // Probably a subdirectory — recurse. listDir returns null if it's actually a file.
      await walkPublic(source, full, seen, covered, depth + 1);
    }
  }
}
