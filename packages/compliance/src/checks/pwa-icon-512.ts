import type { FileSource } from '../lib/file-source.js';
import { extractInlineManifest } from '../lib/inline-manifest.js';
import type { CheckResult } from '../types.js';

const NAME = 'PWA 512 px icon';
const STATIC_MANIFEST_PATH = 'web/public/manifest.json';
const VITE_CONFIG_PATH = 'web/vite.config.ts';
const IMAGE = /\.(png|webp|jpe?g)$/i;

export interface ManifestIcon {
  src?: unknown;
  sizes?: unknown;
  purpose?: unknown;
}

/**
 * The square side (≥ 512) an icon can serve as a storefront listing icon, or 0. Qualifies when
 * `sizes` has a square `NxN` with N ≥ 512 and `purpose` is absent or includes `any`, the rule the
 * catalogue (proappstore-online/proappstore#23) and the native storefront (#627) apply (#630).
 */
export function listingIconSize(icon: ManifestIcon): number {
  if (icon.purpose !== undefined && (typeof icon.purpose !== 'string' || !icon.purpose.split(/\s+/).includes('any'))) return 0;
  if (typeof icon.sizes !== 'string') return 0;
  let best = 0;
  for (const token of icon.sizes.split(/\s+/)) {
    const m = /^(\d+)x(\d+)$/i.exec(token);
    if (m && m[1] === m[2] && Number(m[1]) >= 512) best = Math.max(best, Number(m[1]));
  }
  return best;
}

/**
 * Warns when the manifest declares no square icon of at least 512 px with purpose `any`, or when
 * the one it declares is not in web/public (#630). Storefront listings fall back to the app's emoji
 * without it. Warn, not fail: the app works, and the fallback is defined.
 */
export async function checkPwaIcon512(source: FileSource): Promise<CheckResult> {
  let icons: ManifestIcon[];
  let where: string;
  const staticRaw = await source.read(STATIC_MANIFEST_PATH);
  if (staticRaw !== null) {
    try {
      const parsed = JSON.parse(staticRaw) as { icons?: unknown };
      icons = Array.isArray(parsed.icons) ? parsed.icons : [];
    } catch {
      return { name: NAME, status: 'pass', detail: `${STATIC_MANIFEST_PATH} is not valid JSON (already reported by PWA maskable icon check)` };
    }
    where = STATIC_MANIFEST_PATH;
  } else {
    const viteConfig = await source.read(VITE_CONFIG_PATH);
    if (viteConfig === null || !/\bVitePWA\s*\(/.test(viteConfig)) {
      return { name: NAME, status: 'pass', detail: 'no manifest source (already reported by PWA manifest check)' };
    }
    icons = inlineIcons(extractInlineManifest(viteConfig)?.iconsRaw);
    where = `inline manifest in ${VITE_CONFIG_PATH}`;
  }

  const candidates = icons.filter((icon) => listingIconSize(icon) > 0);
  if (candidates.length === 0) return warn(`no square icon ≥512 px with purpose "any" (${where})`);

  // The publish gate's file map holds text files only, so it cannot tell a missing PNG from an
  // unfetched one. Check existence only where the source can see web/public's images (#630).
  const publicFiles = (await source.listDir?.('web/public')) ?? [];
  if (!source.readBytes || !publicFiles.some((f) => IMAGE.test(f))) {
    return { name: NAME, status: 'pass', detail: `${where} (icon files not visible here; not checked)` };
  }
  const missing: string[] = [];
  for (const icon of candidates) {
    const path = publicPath(icon.src);
    if (path === null) return { name: NAME, status: 'pass', detail: where };
    if ((await source.readBytes(path)) !== null) return { name: NAME, status: 'pass', detail: `${path} (${where})` };
    missing.push(path);
  }
  return warn(`declared but missing: ${missing.join(', ')} (${where})`);
}

/** `web/public/<src>` for a root-relative src, or null when it is not one (absolute URL, relative path). */
function publicPath(src: unknown): string | null {
  if (typeof src !== 'string' || !src.startsWith('/') || src.startsWith('//')) return null;
  return `web/public/${src.slice(1).split(/[?#]/)[0]}`;
}

/** The icon objects of an inline `icons: [...]` literal: the string values of src, sizes and purpose. */
function inlineIcons(raw: string | undefined): ManifestIcon[] {
  if (!raw) return [];
  return (raw.match(/\{[^{}]*\}/g) ?? []).map((obj) => {
    const read = (key: string) => new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`).exec(obj)?.[1];
    return { src: read('src'), sizes: read('sizes'), purpose: read('purpose') };
  });
}

function warn(detail: string): CheckResult {
  return {
    name: NAME,
    status: 'warn',
    detail,
    suggestions: [
      "Add a 512×512 PNG with `purpose: 'any'` (or `'any maskable'`) to the manifest icons and to `web/public/`. Storefront listings use it as the app icon; without it they show the emoji. `pas brand icons --write` generates a lettermark if you have no artwork.",
    ],
  };
}
