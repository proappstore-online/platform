import type { FileSource } from '../lib/file-source.js';
import { extractInlineManifest, type InlineManifest } from '../lib/inline-manifest.js';
import type { CheckResult } from '../types.js';

const STATIC_MANIFEST_PATH = 'web/public/manifest.json';
const VITE_CONFIG_PATH = 'web/vite.config.ts';

/**
 * Apps and games must declare which screens and orientations they
 * support, so the storefront can render a coverage badge ("works on
 * 92% of devices · portrait + landscape") and visitors know what to
 * expect before they tap.
 *
 * Two declarations are required:
 *
 *   "orientation":           "any" | "portrait" | "landscape" |
 *                            "portrait-primary" | "landscape-primary"
 *   "min_viewport_width":     320 | 360 | 414 | 600 | 768 | 1024
 *
 * `orientation` is a standard PWA manifest field. `min_viewport_width`
 * is a custom platform field — the smallest screen width (in CSS px)
 * the app renders correctly at. The storefront maps that to a global
 * device-share percentile to render coverage.
 *
 * If you genuinely don't care about orientation, set `"any"`. Don't
 * leave it off — that's the only value that returns a fail.
 *
 * Read from either a static `web/public/manifest.json` or the inline
 * `manifest:{...}` inside VitePWA(...) in `web/vite.config.ts`.
 */
export async function checkViewportSupport(source: FileSource): Promise<CheckResult> {
  const manifest = await loadManifest(source);
  if (!manifest) {
    return {
      name: 'Viewport support',
      status: 'fail',
      detail: `no manifest source found (looked for ${STATIC_MANIFEST_PATH} and a VitePWA(...) block in ${VITE_CONFIG_PATH})`,
    };
  }

  const orientation = manifest.orientation;
  const minWidth = manifest.min_viewport_width;

  const issues: string[] = [];
  const warnings: string[] = [];

  if (typeof orientation !== 'string' || !VALID_ORIENTATIONS.has(orientation)) {
    issues.push(
      `manifest.orientation is "${String(orientation)}" — must be one of: ${[...VALID_ORIENTATIONS].join(', ')}`,
    );
  }

  if (typeof minWidth !== 'number') {
    warnings.push(
      'manifest.min_viewport_width is missing — assuming 320 (strictest). ' +
        'Set explicitly to e.g. 360 / 414 / 600 / 768 / 1024 to declare which devices the app supports.',
    );
  } else if (minWidth < 320) {
    issues.push(`manifest.min_viewport_width=${minWidth} is below the 320px minimum`);
  } else if (!RECOMMENDED_WIDTHS.includes(minWidth)) {
    warnings.push(
      `manifest.min_viewport_width=${minWidth} is unusual — recommended values: ${RECOMMENDED_WIDTHS.join(', ')}`,
    );
  }

  if (issues.length > 0) {
    return {
      name: 'Viewport support',
      status: 'fail',
      detail: `${issues.length} viewport-declaration issue${issues.length === 1 ? '' : 's'}`,
      suggestions: [
        ...issues,
        'Add `"orientation": "any"` (or portrait/landscape) and `"min_viewport_width": 360` to the manifest — either in web/public/manifest.json or inside the manifest:{...} of VitePWA() in web/vite.config.ts.',
      ],
    };
  }
  if (warnings.length > 0) {
    return {
      name: 'Viewport support',
      status: 'warn',
      detail: warnings[0]!,
      suggestions: warnings,
    };
  }
  return {
    name: 'Viewport support',
    status: 'pass',
    detail: `orientation=${orientation as string} · min ${minWidth}px`,
  };
}

async function loadManifest(
  source: FileSource,
): Promise<InlineManifest | Record<string, unknown> | null> {
  const staticRaw = await source.read(STATIC_MANIFEST_PATH);
  if (staticRaw !== null) {
    try {
      return JSON.parse(staticRaw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const viteConfig = await source.read(VITE_CONFIG_PATH);
  if (viteConfig !== null && /\bVitePWA\s*\(/.test(viteConfig)) {
    return extractInlineManifest(viteConfig);
  }
  return null;
}

const VALID_ORIENTATIONS = new Set([
  'any',
  'portrait',
  'landscape',
  'portrait-primary',
  'landscape-primary',
]);

const RECOMMENDED_WIDTHS = [320, 360, 414, 600, 768, 1024];
