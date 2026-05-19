import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

const MANIFEST_PATH = 'web/public/manifest.json';

/**
 * Apps and games must declare which screens and orientations they
 * support, so the storefront can render a coverage badge ("works on
 * 92% of devices · portrait + landscape") and visitors know what to
 * expect before they tap.
 *
 * Two declarations are required, both in `web/public/manifest.json`:
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
 */
export async function checkViewportSupport(source: FileSource): Promise<CheckResult> {
  const raw = await source.read(MANIFEST_PATH);
  if (raw === null) {
    return {
      name: 'Viewport support',
      status: 'fail',
      detail: `${MANIFEST_PATH} not found`,
    };
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      name: 'Viewport support',
      status: 'fail',
      detail: `${MANIFEST_PATH} unparseable`,
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
        'Edit web/public/manifest.json: add "orientation": "any" (or portrait/landscape) and "min_viewport_width": 360.',
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

const VALID_ORIENTATIONS = new Set([
  'any',
  'portrait',
  'landscape',
  'portrait-primary',
  'landscape-primary',
]);

const RECOMMENDED_WIDTHS = [320, 360, 414, 600, 768, 1024];
