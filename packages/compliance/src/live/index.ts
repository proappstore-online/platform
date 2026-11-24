/**
 * Live-URL audit checks. Unlike the file-walking checks in ../checks/,
 * these run inside a Cloudflare Worker (no filesystem) against published
 * apps' live URLs to catch post-publish drift.
 *
 * What we can check from a live URL:
 *   - Tracking SDK injection (script src, inline scripts, fetched JS)
 *   - Brand fonts presence (link href to fonts.googleapis.com)
 *   - PWA manifest reachable + valid
 *   - The manifest's 512 px listing icon answers with an image
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
import { matchedTrackers } from '../checks/no-tracking.js';
import { listingIconSize, type ManifestIcon } from '../checks/pwa-icon-512.js';
import type { CheckResult } from '../types.js';
import { annotateByName } from '../clause-map.js';

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
  const report = await auditLiveRaw(input);
  // #166: every live result carries its stable id + clause citations too.
  report.results = report.results.map(annotateByName);
  return report;
}

async function auditLiveRaw(input: LiveAuditInput): Promise<LiveAuditReport> {
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
  const loaded = loadManifest(html, input.liveUrl);
  const [tracking, fonts, manifest, bundle, vh, icon] = await Promise.all([
    checkNoTrackingLive(html),
    checkBrandFontsLive(html),
    loaded.then((m) => m.result),
    checkBundleSizeLive(html, input.liveUrl),
    checkUnsafeVhLive(html, input.liveUrl),
    loaded.then((m) => checkIcon512Live(m.manifest, m.url)),
  ]);
  report.results.push(tracking, fonts, manifest, bundle, vh, icon);
  return report;
}

export function checkNoTrackingLive(html: string): CheckResult {
  // Uses the SAME hardened SDK-context patterns as the source-side check, so a
  // compliant synth/audio/physics app whose HTML merely contains the word
  // "amplitude" (or a locally-defined gtag) is no longer falsely flagged.
  const found = matchedTrackers(html);
  if (found.length === 0) {
    return { name: 'No tracking SDKs (live)', status: 'pass', detail: 'no known trackers in HTML' };
  }
  return {
    name: 'No tracking SDKs (live)',
    status: 'fail',
    detail: `tracker SDK detected: ${found.join(', ')}`,
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
  return (await loadManifest(html, liveUrl)).result;
}

interface LoadedManifest {
  result: CheckResult;
  /** The parsed manifest and its URL, when it was fetched and parsed. */
  manifest?: { icons?: unknown };
  url?: string;
}

/** Fetches the manifest once for both PWA manifest (live) and PWA 512 px icon (live). */
async function loadManifest(html: string, liveUrl: string): Promise<LoadedManifest> {
  const name = 'PWA manifest (live)';
  // Find the manifest link in the HTML, then fetch + validate it.
  const m = /<link[^>]*rel=["']manifest["'][^>]*href=["']([^"']+)["']/i.exec(html);
  if (!m) {
    return { result: { name, status: 'fail', detail: 'no <link rel="manifest"> in HTML' } };
  }
  const href = m[1]!;
  const manifestUrl = new URL(href, liveUrl).toString();
  try {
    const res = await fetchWithTimeout(manifestUrl);
    if (!res.ok) {
      return { result: { name, status: 'fail', detail: `${manifestUrl} → HTTP ${res.status}` } };
    }
    const body = (await res.json()) as { name?: string; display?: string; start_url?: string; icons?: unknown };
    const missing: string[] = [];
    if (!body.name) missing.push('name');
    if (!body.display) missing.push('display');
    if (!body.start_url) missing.push('start_url');
    const result: CheckResult = missing.length > 0
      ? { name, status: 'fail', detail: `manifest missing fields: ${missing.join(', ')}` }
      : { name, status: 'pass', detail: manifestUrl };
    return { result, manifest: body, url: manifestUrl };
  } catch (err) {
    const skipped = isSubrequestCapError(err);
    return {
      result: {
        name,
        status: skipped ? 'warn' : 'fail',
        detail: skipped
          ? 'audit Worker hit subrequest cap — re-run needed'
          : err instanceof Error
            ? err.message
            : 'manifest fetch/parse failed',
      },
    };
  }
}

/**
 * Fetches the manifest's largest square icon of at least 512 px with purpose `any` and warns unless
 * it answers 200 with a PNG, JPEG or WebP type (#630): a declared icon that 404s leaves the app's
 * storefront listing on its emoji. Takes the manifest `loadManifest` already fetched.
 */
export async function checkIcon512Live(manifest: { icons?: unknown } | undefined, manifestUrl: string | undefined): Promise<CheckResult> {
  const name = 'PWA 512 px icon (live)';
  if (!manifest || !manifestUrl) {
    return { name, status: 'pass', detail: 'no manifest (already reported by PWA manifest (live))' };
  }
  const icons = (Array.isArray(manifest.icons) ? manifest.icons : []) as ManifestIcon[];
  const best = icons
    .filter((icon) => typeof icon?.src === 'string' && listingIconSize(icon) > 0)
    .sort((a, b) => listingIconSize(b) - listingIconSize(a))[0];
  if (!best) return { name, status: 'warn', detail: 'manifest declares no square icon ≥512 px with purpose "any"' };
  const iconUrl = new URL(best.src as string, manifestUrl).toString();
  try {
    const res = await fetchWithTimeout(iconUrl);
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && /^image\/(png|jpeg|webp)\b/i.test(type)) return { name, status: 'pass', detail: iconUrl };
    return { name, status: 'warn', detail: `${iconUrl} → HTTP ${res.status}${type ? ` (${type})` : ''}` };
  } catch (err) {
    return {
      name,
      status: 'warn',
      detail: isSubrequestCapError(err)
        ? 'audit Worker hit subrequest cap — re-run needed'
        : `${iconUrl}: ${err instanceof Error ? err.message : 'fetch failed'}`,
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
