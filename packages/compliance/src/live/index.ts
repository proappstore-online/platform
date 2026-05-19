/**
 * Live-URL audit checks. Unlike the file-walking checks in ../checks/,
 * these run inside a Cloudflare Worker (no filesystem) against published
 * apps' live URLs to catch post-publish drift.
 *
 * What we can check from a live URL:
 *   - Tracking SDK injection (script src, inline scripts, fetched JS)
 *   - Brand fonts presence (link href to fonts.googleapis.com)
 *   - PWA manifest reachable + valid
 *   - Main bundle size (HEAD request)
 *
 * What we CAN'T check post-publish:
 *   - APPNAME placeholders (build erases these)
 *   - Brand-override CSS variables (sourcemaps not always shipped)
 *
 * The audit Worker runs these on a weekly cron and stores per-app
 * results in D1 so creators (or platform admins) can see drift over
 * time without leaving the storefront.
 */

import { gzipByteLength } from '../lib/gzip.js';
import type { CheckResult } from '../types.js';

const TRACKER_PATTERNS = [
  /google-analytics\.com/i,
  /gtag\(/i,
  /googletagmanager\.com/i,
  /\bamplitude\b/i,
  /\bmixpanel\b/i,
  /\bsegment\.com\b/i,
  /\bhotjar\.com\b/i,
  /plausible\.io/i,
  /posthog\.com/i,
];

export interface LiveAuditInput {
  appId: string;
  liveUrl: string; // e.g. https://tip.proappstore.online
}

export interface LiveAuditReport {
  appId: string;
  liveUrl: string;
  checkedAt: number;
  reachable: boolean;
  results: CheckResult[];
}

/**
 * Fetch with a timeout — Workers' default fetch waits 30s+, too slow
 * when iterating 50+ apps in one cron tick.
 */
async function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Worker subrequest cap errors look like "Too many subrequests by
 * single Worker invocation." We don't want to record those as "fail"
 * verdicts because the app isn't actually broken — the audit just
 * couldn't check. Detect and flag for the caller.
 */
function isSubrequestCapError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /too many subrequests|subrequest.*limit/i.test(msg);
}

export async function auditLive(input: LiveAuditInput): Promise<LiveAuditReport> {
  const checkedAt = Date.now();
  const report: LiveAuditReport = {
    appId: input.appId,
    liveUrl: input.liveUrl,
    checkedAt,
    reachable: false,
    results: [],
  };

  let html: string;
  try {
    const res = await fetchWithTimeout(input.liveUrl);
    if (!res.ok) {
      report.results.push({
        name: 'Reachable',
        status: 'fail',
        detail: `HTTP ${res.status} from ${input.liveUrl}`,
      });
      return report;
    }
    html = await res.text();
    report.reachable = true;
    // Always record a Reachable row on success — otherwise stale
    // "Reachable: fail" rows from previous failed runs (e.g.
    // subrequest-cap noise) never get overwritten, because the
    // upsert is keyed on (app_id, check_name).
    report.results.push({
      name: 'Reachable',
      status: 'pass',
      detail: `${input.liveUrl} → HTTP ${res.status}`,
    });
  } catch (err) {
    // Subrequest cap means we couldn't even fetch — that's a "warn"
    // (re-check needed), not a "fail" (app broken). Distinguishing
    // matters: failures show red badges in the storefront.
    const skipped = isSubrequestCapError(err);
    report.results.push({
      name: 'Reachable',
      status: skipped ? 'warn' : 'fail',
      detail: skipped
        ? 'audit Worker hit subrequest cap — re-run needed'
        : err instanceof Error
          ? err.message
          : 'fetch failed',
    });
    return report;
  }

  // Run all checks in parallel — each is independent.
  const [tracking, fonts, manifest, bundle, vh] = await Promise.all([
    checkNoTrackingLive(html),
    checkBrandFontsLive(html),
    checkManifestLive(html, input.liveUrl),
    checkBundleSizeLive(html, input.liveUrl),
    checkUnsafeVhLive(html, input.liveUrl),
  ]);
  report.results.push(tracking, fonts, manifest, bundle, vh);
  return report;
}

export function checkNoTrackingLive(html: string): CheckResult {
  const found = TRACKER_PATTERNS.filter((re) => re.test(html));
  if (found.length === 0) {
    return { name: 'No tracking SDKs (live)', status: 'pass', detail: 'no known trackers in HTML' };
  }
  return {
    name: 'No tracking SDKs (live)',
    status: 'fail',
    detail: `${found.length} pattern${found.length === 1 ? '' : 's'} matched`,
    suggestions: [
      'Tracking was injected after publish — remove the script tag or third-party loader.',
    ],
  };
}

export function checkBrandFontsLive(html: string): CheckResult {
  const hasManrope = /manrope/i.test(html);
  const hasFraunces = /fraunces/i.test(html);
  if (hasManrope && hasFraunces) {
    return { name: 'Brand fonts (live)', status: 'pass', detail: 'Manrope + Fraunces referenced' };
  }
  const missing: string[] = [];
  if (!hasManrope) missing.push('Manrope');
  if (!hasFraunces) missing.push('Fraunces');
  return {
    name: 'Brand fonts (live)',
    status: 'fail',
    detail: `missing: ${missing.join(', ')}`,
    suggestions: ['Restore the Google Fonts <link> in web/index.html.'],
  };
}

export async function checkManifestLive(html: string, liveUrl: string): Promise<CheckResult> {
  // Find the manifest link in the HTML, then fetch + validate it.
  const m = /<link[^>]*rel=["']manifest["'][^>]*href=["']([^"']+)["']/i.exec(html);
  if (!m) {
    return {
      name: 'PWA manifest (live)',
      status: 'fail',
      detail: 'no <link rel="manifest"> in HTML',
    };
  }
  const href = m[1]!;
  const manifestUrl = new URL(href, liveUrl).toString();
  try {
    const res = await fetchWithTimeout(manifestUrl);
    if (!res.ok) {
      return {
        name: 'PWA manifest (live)',
        status: 'fail',
        detail: `${manifestUrl} → HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { name?: string; display?: string; start_url?: string };
    const missing: string[] = [];
    if (!body.name) missing.push('name');
    if (!body.display) missing.push('display');
    if (!body.start_url) missing.push('start_url');
    if (missing.length > 0) {
      return {
        name: 'PWA manifest (live)',
        status: 'fail',
        detail: `manifest missing fields: ${missing.join(', ')}`,
      };
    }
    return { name: 'PWA manifest (live)', status: 'pass', detail: manifestUrl };
  } catch (err) {
    const skipped = isSubrequestCapError(err);
    return {
      name: 'PWA manifest (live)',
      status: skipped ? 'warn' : 'fail',
      detail: skipped
        ? 'audit Worker hit subrequest cap — re-run needed'
        : err instanceof Error
          ? err.message
          : 'manifest fetch/parse failed',
    };
  }
}

export async function checkBundleSizeLive(html: string, liveUrl: string): Promise<CheckResult> {
  // Find the largest-looking bundled JS reference. Vite output looks like
  // src="/assets/index-XYZ.js" — starts with `/`, no chars before. Use
  // `[^"']*` (zero or more) instead of `[^"']+` (one or more) so the
  // root-relative path matches; with `+` every Vite app was misreported
  // as "non-Vite layout" and the audit silently skipped bundle-size.
  const m = /<script[^>]+src=["']([^"']*\/assets\/[^"']+\.js)["']/i.exec(html);
  if (!m) {
    // Plausible miss for non-Vite apps — not a fail, just skip.
    return {
      name: 'Bundle size (live)',
      status: 'warn',
      detail: 'no /assets/*.js found — non-Vite layout?',
    };
  }
  const jsUrl = new URL(m[1]!, liveUrl).toString();
  try {
    const res = await fetchWithTimeout(jsUrl);
    if (!res.ok) {
      return { name: 'Bundle size (live)', status: 'fail', detail: `${jsUrl} → ${res.status}` };
    }
    const body = await res.arrayBuffer();
    // Real gzip via the shared helper — same math the source-side
    // check uses, so live and source verdicts can never disagree on
    // a borderline app.
    const rawKb = Math.round(body.byteLength / 1024);
    const gzippedBytes = await gzipByteLength(new Uint8Array(body));
    const gzipKb = Math.round(gzippedBytes / 1024);
    if (gzipKb > 300) {
      return {
        name: 'Bundle size (live)',
        status: 'fail',
        detail: `${gzipKb} KB gzipped (raw ${rawKb} KB) — over 300 KB limit`,
      };
    }
    return {
      name: 'Bundle size (live)',
      status: 'pass',
      detail: `${gzipKb} KB gzipped (raw ${rawKb} KB)`,
    };
  } catch (err) {
    const skipped = isSubrequestCapError(err);
    return {
      name: 'Bundle size (live)',
      status: 'warn',
      detail: skipped
        ? 'audit Worker hit subrequest cap — re-run needed'
        : err instanceof Error
          ? err.message
          : 'bundle fetch failed',
    };
  }
}

/**
 * Live counterpart to checkUnsafeVh. Fetches the first bundled
 * stylesheet linked from the HTML and scans it for `100vh` (the
 * unit, not the Tailwind class — by build time those have been
 * compiled to CSS). Catches whiteboard-class iOS Safari URL-bar
 * scroll bugs in apps that have already shipped.
 *
 * Cost: one extra subrequest per app. The audit Worker runs near the
 * free-plan subrequest cap; on cap errors we degrade to `warn`
 * (re-run needed) rather than `fail` (app broken) — the app isn't
 * actually broken, the audit just couldn't check.
 */
export async function checkUnsafeVhLive(html: string, liveUrl: string): Promise<CheckResult> {
  // Find the first bundled stylesheet. Vite output looks like
  // <link rel="stylesheet" href="/assets/index-XYZ.css">. Be
  // tolerant of attribute order — rel and href can appear either way.
  const m =
    /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+\.css[^"']*)["']/i.exec(html) ??
    /<link[^>]+href=["']([^"']+\.css[^"']*)["'][^>]*rel=["']stylesheet["']/i.exec(html);
  if (!m) {
    // No stylesheet link — could be inline-only styles, or styles
    // injected at runtime. Not a fail; just nothing to check.
    return {
      name: 'No unsafe 100vh (live)',
      status: 'warn',
      detail: 'no <link rel="stylesheet"> found in HTML — skipped',
    };
  }
  const cssUrl = new URL(m[1]!, liveUrl).toString();
  try {
    const res = await fetchWithTimeout(cssUrl);
    if (!res.ok) {
      return {
        name: 'No unsafe 100vh (live)',
        status: 'warn',
        detail: `${cssUrl} → HTTP ${res.status}`,
      };
    }
    const css = await res.text();
    const matches = css.match(/\b100vh\b/g) ?? [];
    if (matches.length === 0) {
      return { name: 'No unsafe 100vh (live)', status: 'pass', detail: `scanned ${cssUrl}` };
    }
    return {
      name: 'No unsafe 100vh (live)',
      status: 'warn',
      detail: `${matches.length} occurrence(s) of 100vh in ${cssUrl}`,
      suggestions: [
        '100vh resolves to the layout viewport on iOS Safari — when the URL bar is visible the page scrolls.',
        'Replace with 100svh (small viewport — accounts for visible browser UI) or 100dvh (dynamic — recomputes as URL bar moves).',
      ],
    };
  } catch (err) {
    const skipped = isSubrequestCapError(err);
    return {
      name: 'No unsafe 100vh (live)',
      status: 'warn',
      detail: skipped
        ? 'audit Worker hit subrequest cap — re-run needed'
        : err instanceof Error
          ? err.message
          : 'CSS fetch failed',
    };
  }
}
