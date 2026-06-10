import type { FileSource } from '../lib/file-source.js';
import { stripCommentsAndStrings, stripHtmlComments } from '../lib/strip.js';
import type { CheckResult } from '../types.js';
import {
  findUncoveredAssets,
  sourceHasSwRegistration,
} from './pwa-offline-assets.js';
import {
  extOf,
  extractBalancedBlock,
  extractCoveredExtensions,
  parseBundleCap,
} from './pwa-offline-workbox.js';

const VITE_CONFIG = 'web/vite.config.ts';
const INDEX_HTML = 'web/index.html';
const PUBLIC_DIR = 'web/public';

/**
 * Two things this check enforces:
 *
 *   1. Platform mandate — every app on proappstore.online MUST be an
 *      installable PWA (service worker registered). Triggered whenever
 *      a project has a `web/index.html` (the universal signal of a
 *      Vite app destined for the storefront). Hand-rolled
 *      `serviceWorker.register` counts; vite-plugin-pwa counts. Anything
 *      else fails. Non-app repos that don't ship a web entry are
 *      naturally exempt — they're not subject to compliance anyway.
 *
 *   2. Offline-correctness quality — among PWAs that ARE configured,
 *      the workbox setup actually has to work from the home screen
 *      while offline. Apps that ship a manifest but mis-configure the
 *      service worker install fine, then show a blank screen offline.
 *
 * Three quality failure modes this catches, all observed in the wild:
 *
 *  1. `maximumFileSizeToCacheInBytes` left at the workbox default (2 MB).
 *     Any bundle chunk above 2 MB is silently dropped from the precache.
 *     The SW serves index.html from cache, then the JS chunk 404s offline.
 *
 *  2. Google Fonts loaded via render-blocking <link> in index.html with
 *     no `runtimeCaching` rule. Browser HTTP cache works most of the
 *     time, but standalone-mode launches on iOS bypass it inconsistently
 *     — fonts fall back to system, and on cold first offline launch the
 *     <link> can stall paint for hundreds of ms.
 *
 *  3. Assets in extensions not covered by `globPatterns`. The default
 *     list is js/css/html/png/svg/ico/woff2. Any wasm, json, audio, etc.
 *     shipped under web/public/ isn't precached → offline 404.
 *
 * Also catches the inverse: index.html links a manifest but the config
 * has no service worker at all → "installable" PWA that always needs
 * network.
 */
export async function checkPwaOffline(source: FileSource): Promise<CheckResult> {
  const config = await source.read(VITE_CONFIG);
  const html = await source.read(INDEX_HTML);

  // Strip HTML comments before matching — `<!-- <link rel="manifest"> -->`
  // is not a live install claim, and a commented-out fonts <link> is
  // not loading anything.
  const htmlCode = html === null ? null : stripHtmlComments(html);
  const linksManifest =
    htmlCode !== null && /<link[^>]+rel\s*=\s*["']manifest["']/i.test(htmlCode);
  const linksGoogleFonts =
    htmlCode !== null && /fonts\.(googleapis|gstatic)\.com/i.test(htmlCode);

  // Strip comments and string-literal contents before any regex matching
  // against the config text — otherwise `VitePWA(` in a comment or
  // `"workbox: {"` in a string is treated as real code (false positive).
  const configCode = config === null ? null : stripCommentsAndStrings(config);
  const hasVitePwa = configCode !== null && /\bVitePWA\s*\(/.test(configCode);
  // `injectManifest` strategy means the developer writes their own SW
  // file (typically web/src/sw.ts). The `workbox` field doesn't apply
  // — `injectManifest` config does — so the rest of our checks are
  // inapplicable. Trust the dev's manual SW. (Matched against `config`
  // — not `configCode` — because the string-stripping would erase
  // `"injectManifest"` from the latter.)
  const usesInjectManifest =
    config !== null && /strategies\s*:\s*["']injectManifest["']/.test(config);
  // Hand-rolled SW registration (e.g. an inline <script> calling
  // navigator.serviceWorker.register) is a legitimate alternative to
  // vite-plugin-pwa. If it exists, we trust the dev to manage their own
  // precache and limit ourselves to the install-claim check.
  const hasManualSw =
    (html !== null && /serviceWorker\.register/.test(html)) ||
    (await sourceHasSwRegistration(source));
  const hasServiceWorker = hasVitePwa || hasManualSw;

  // Platform mandate (proappstore.online): every app must be an
  // installable PWA. "Installable" at the static-check level means a
  // service worker registers — VitePWA (which also injects the
  // manifest link), an injectManifest setup, or hand-rolled register.
  // Triggered by the presence of `web/index.html` (the universal signal
  // of a Vite-built app). Repos that don't ship a web entry — admin
  // tools, backends, agents — are naturally exempt; compliance isn't
  // run against them anyway.
  if (html !== null && !hasServiceWorker) {
    return {
      name: 'PWA offline correctness',
      status: 'fail',
      detail: 'platform mandate: every app on proappstore.online must be an installable PWA, but no service worker is registered',
      suggestions: [
        'Add `vite-plugin-pwa` to web/devDependencies, then wire `VitePWA({...})` into vite.config.ts plugins. Mirror the canonical config used in the canonical scaffolds, etc.',
        'Or, if you prefer to manage your own SW, register it from web/src/main.tsx with `navigator.serviceWorker.register("/sw.js")` and ship the SW yourself.',
      ],
    };
  }

  // "Installable" claim with no service worker — the worst failure mode.
  // The PWA installs from the manifest but launches into a network fetch
  // for `/` that 404s offline → blank screen on home screen.
  if (linksManifest && !hasServiceWorker) {
    return {
      name: 'PWA offline correctness',
      status: 'fail',
      detail: 'index.html links a manifest but no service worker is registered → installable PWA that cannot load offline from home screen',
      suggestions: [
        'Install vite-plugin-pwa and add VitePWA({...}) to vite.config.ts plugins.',
        'Or register a service worker manually (`navigator.serviceWorker.register("/sw.js")`).',
        'Or drop the <link rel="manifest"> from index.html if this is not meant to be installable.',
      ],
    };
  }

  // No vite.config.ts at all — can't analyze further. Either not a Vite
  // project, or PWA wiring lives elsewhere; either way, nothing for us
  // to assert about workbox.
  if (config === null) {
    return {
      name: 'PWA offline correctness',
      status: 'pass',
      detail: hasManualSw
        ? 'no vite.config.ts; hand-rolled service worker present'
        : 'no web/vite.config.ts (not a Vite project)',
    };
  }

  if (!hasVitePwa) {
    return {
      name: 'PWA offline correctness',
      status: 'pass',
      detail: hasManualSw
        ? 'hand-rolled service worker; no install claim to verify'
        : 'not a PWA (no VitePWA, no manifest link)',
    };
  }

  // injectManifest: developer hand-writes the SW. Their `workbox` config
  // (if any) is irrelevant; the analyzable surface lives in their SW
  // source which we don't parse.
  if (usesInjectManifest) {
    return {
      name: 'PWA offline correctness',
      status: 'pass',
      detail: 'VitePWA with injectManifest strategy — SW managed in src',
    };
  }

  // Extract the workbox block. Match `workbox: { ... }` allowing nested
  // braces. We pass `configCode` (comments/strings stripped) so the
  // matcher can't false-positive on `"workbox: {"` inside a string, but
  // we slice out of `config` so the returned substring still has its
  // real string contents — otherwise downstream `globPatterns:
  // ["..."]` regex would fail.
  const workbox = extractBalancedBlock(config, configCode, /workbox\s*:\s*\{/);
  if (workbox === null) {
    return {
      name: 'PWA offline correctness',
      status: 'warn',
      detail: 'VitePWA present but no workbox block parsed — defaults may leave assets unprecached',
      suggestions: [
        'Add a `workbox: { ... }` block with globPatterns, maximumFileSizeToCacheInBytes, and runtimeCaching.',
      ],
    };
  }

  const issues: string[] = [];
  const suggestions: string[] = [];

  // Platform-owned same-origin routes are not app routes. If Workbox's
  // navigation fallback handles them, OAuth callbacks can be served as the
  // SPA instead of reaching the PAS host worker that sets HttpOnly cookies.
  const hasPasNavigationDenylist =
    /navigateFallbackDenylist\s*:\s*\[[\s\S]*\\\.pas/.test(workbox) ||
    /navigateFallbackDenylist\s*:\s*\[[\s\S]*["']\/\.pas/.test(workbox);
  if (!hasPasNavigationDenylist) {
    return {
      name: 'PWA offline correctness',
      status: 'fail',
      detail: 'workbox navigation fallback does not denylist PAS reserved routes (`/.pas/*`), so auth callbacks and platform mediation can be intercepted by the app service worker',
      suggestions: [
        'Add `navigateFallbackDenylist: [/^\\/\\.pas\\//]` to the VitePWA workbox config.',
      ],
    };
  }

  // Issue 1: bundle-size cap. Default is 2 MiB; many real bundles exceed it.
  // Also catch the inverse footgun: a value *lower* than the default
  // (e.g. someone copy-pasted `1024` thinking it was MB), which silently
  // makes precache worse.
  const capValue = parseBundleCap(workbox);
  const DEFAULT_CAP = 2 * 1024 * 1024;
  if (capValue === null) {
    issues.push('no maximumFileSizeToCacheInBytes (defaults to 2 MB — bigger chunks silently skipped from precache)');
    suggestions.push('Set `maximumFileSizeToCacheInBytes: 10 * 1024 * 1024` so the main bundle is precached.');
  } else if (capValue < DEFAULT_CAP) {
    issues.push(`maximumFileSizeToCacheInBytes is ${capValue} bytes — smaller than the workbox default (2 MB); any chunk above this is dropped from precache`);
    suggestions.push('Raise to at least `10 * 1024 * 1024` (10 MB) so real bundles fit.');
  }

  // `VitePWA({ disable: true })` literal turns the plugin off in all
  // environments, so the manifest link is broken. Only flag the
  // unconditional literal — `disable: process.env.NODE_ENV !==
  // "production"` is a common, correct dev-only pattern that we can't
  // evaluate statically.
  if (configCode && /\bdisable\s*:\s*true\b/.test(configCode)) {
    issues.push('VitePWA({ disable: true }) literal — service worker will never register');
    suggestions.push('Drop `disable: true`, or gate it behind a non-production check.');
  }

  // Issue 2: Google Fonts with no runtime caching.
  if (linksGoogleFonts) {
    const hasGoogleApisRule = /fonts\\?\.googleapis\\?\.com/.test(workbox);
    const hasGstaticRule = /fonts\\?\.gstatic\\?\.com/.test(workbox);
    // Workbox also lets you target by `request.destination` — a rule
    // like `({request}) => request.destination === "font"` catches
    // every font request including Google Fonts. Accept that as
    // covering both endpoints rather than emitting a false warn.
    const hasDestinationFontRule =
      /\bdestination\b/.test(workbox) && /["']font["']/.test(workbox);
    const fontsCovered =
      (hasGoogleApisRule && hasGstaticRule) || hasDestinationFontRule;
    if (!fontsCovered) {
      issues.push('index.html loads Google Fonts but workbox has no runtimeCaching for fonts.googleapis.com / fonts.gstatic.com');
      suggestions.push(
        'Add runtimeCaching CacheFirst rules for /^https:\\/\\/fonts\\.googleapis\\.com/ and /^https:\\/\\/fonts\\.gstatic\\.com/.',
      );
    }
  }

  // Issue 3: assets in public/ in extensions not covered by globPatterns.
  // Workbox supports multiple patterns in the array; we union the
  // extensions across all of them, otherwise a config like
  // `globPatterns: ["**/*.{js,css}", "**/*.wasm"]` would look like it
  // omits wasm.
  const covered = extractCoveredExtensions(workbox);
  if (covered !== null && source.listDir) {
    const uncovered = await findUncoveredAssets(source, PUBLIC_DIR, covered);
    if (uncovered.length > 0) {
      const sample = uncovered.slice(0, 3).join(', ');
      issues.push(`web/public/ has files in extensions not in globPatterns: ${sample}${uncovered.length > 3 ? ` (+${uncovered.length - 3} more)` : ''}`);
      const newExts = [...new Set([...covered, ...uncovered.map(extOf)])].filter(Boolean).join(',');
      suggestions.push(`Extend globPatterns to cover them, e.g. \`**/*.{${newExts}}\`.`);
    }
  }

  if (issues.length === 0) {
    return {
      name: 'PWA offline correctness',
      status: 'pass',
      detail: 'workbox precaches everything, fonts cached, bundle cap raised',
    };
  }

  return {
    name: 'PWA offline correctness',
    status: 'warn',
    detail: issues.join('; '),
    suggestions,
  };
}
