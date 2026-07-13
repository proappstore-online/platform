import type { FileSource } from '../lib/file-source.js';
import { stripCommentsForExt } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

// Each tracker carries one or more patterns that should ONLY match real SDK
// usage — never bare English words used as geometry / math / physics terms.
//
// Distinctive package names (mixpanel, plausible, posthog, hotjar) are safe
// with word-boundary matching. Ambiguous English words (segment, amplitude)
// require SDK-context patterns (scoped import, hostname, call site).
type TrackerSpec = {
  name: string;
  patterns: RegExp[];
};

function wb(name: string): RegExp {
  // word-boundary, case-insensitive: only matches the literal token surrounded
  // by non-word chars (or string start/end). Avoids `segmentation`, `collideSegment`.
  return new RegExp(`(?:^|[^a-zA-Z0-9_])${escapeForRegExp(name)}(?:$|[^a-zA-Z0-9_])`, 'i');
}

export const TRACKERS: TrackerSpec[] = [
  { name: 'google-analytics', patterns: [/google-analytics/i, /googletagmanager\.com/i] },
  // `gtag` as a bare token would catch nothing real, but the GA install snippet
  // always calls it like `gtag('config', ...)` or `gtag('event', ...)` or
  // declares `window.gtag = ...`. Match those, not the bare identifier.
  { name: 'gtag', patterns: [/\bgtag\s*\(\s*['"]/i, /window\.gtag\b/i, /gtag\.js/i] },
  // Amplitude SDK shows up as @amplitude/* scoped package, amplitude.com host,
  // or amplitude.init/track/getInstance call. Bare `amplitude` (the math term)
  // is fine.
  {
    name: 'amplitude',
    patterns: [
      /@amplitude\//i,
      /amplitude\.com/i,
      /\bamplitude\s*\.\s*(?:init|track|getInstance|setUserId|logEvent)\b/i,
      /require\(['"]amplitude/i,
      /from\s+['"]amplitude/i,
    ],
  },
  { name: 'mixpanel', patterns: [wb('mixpanel')] },
  // Segment SDK: scoped package, hostname, or window.analytics.track/identify.
  // Bare `segment` (geometry term — ball-line-segment, drop-target row segment)
  // is fine.
  {
    name: 'segment',
    patterns: [
      /@segment\//i,
      /segment\.io/i,
      /segment\.com\/analytics/i,
      /cdn\.segment\.com/i,
      /window\.analytics\s*\.\s*(?:track|identify|page|group)\b/i,
      /\bAnalyticsBrowser\.load\b/i,
    ],
  },
  { name: 'hotjar', patterns: [wb('hotjar')] },
  { name: 'plausible', patterns: [wb('plausible')] },
  { name: 'posthog', patterns: [wb('posthog')] },
];

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.html', '.json']);

/**
 * Names of any trackers whose SDK-context patterns match `text`. Shared with the
 * live-URL audit so both the source-side check and the post-publish check use
 * the SAME hardened patterns — a bare English word like "amplitude" must never
 * be a hit in either place. Returns [] when clean.
 */
export function matchedTrackers(text: string): string[] {
  return TRACKERS.filter((t) => t.patterns.some((re) => re.test(text))).map((t) => t.name);
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Per-game compliance tests legitimately mention these tracker names as
// the banned list they assert NOT to find. Treating those as positives
// is the classic "check finds its own assertion" false positive.
function isSelfReferenceTestFile(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)\//.test(path) && /compliance\.test\.[jt]sx?$/.test(path);
}

export async function checkNoTracking(source: FileSource): Promise<CheckResult> {
  const hits: { file: string; matches: string[] }[] = [];

  for await (const path of source.list()) {
    const ext = extOf(path);
    if (!SCAN_EXTS.has(ext)) continue;
    if (isSelfReferenceTestFile(path)) continue;
    const raw = await source.read(path);
    if (!raw) continue;
    // Strip comments only — NOT string literals. Real tracker imports
    // live inside strings (`import from "@amplitude/..."`,
    // `<script src="https://www.google-analytics.com/...">`), so
    // erasing string contents would erase the very evidence we need.
    // A rare false positive remains if someone mentions a tracker name
    // inside a non-import string literal; comment-stripping handles the
    // common case (documentation comments).
    const content = stripCommentsForExt(raw, ext);
    const matches = TRACKERS.filter((t) => t.patterns.some((re) => re.test(content))).map(
      (t) => t.name,
    );
    if (matches.length > 0) {
      hits.push({ file: path, matches });
    }
  }

  if (hits.length === 0) {
    return {
      name: 'No tracking SDKs',
      status: 'pass',
      detail: `scanned for ${TRACKERS.length} known trackers`,
    };
  }

  return {
    name: 'No tracking SDKs',
    status: 'fail',
    detail: `${hits.length} file(s) reference trackers: ${hits
      .slice(0, 3)
      .map((h) => `${h.file} (${h.matches.join(', ')})`)
      .join('; ')}${hits.length > 3 ? '…' : ''}`,
    suggestions: [
      'ProAppStore apps must be tracking-free. Remove the SDK + any analytics calls.',
      'For private-by-design metrics, CF edge analytics already counts requests anonymously.',
    ],
  };
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}
