import { checkAccessibilityStatic } from './checks/accessibility-static.js';
import { checkBrandFonts } from './checks/brand-fonts.js';
import { checkBrandTokens } from './checks/brand-tokens.js';
import { checkBundleSize } from './checks/bundle-size.js';
import { checkClaudeMdSlim } from './checks/claude-md-slim.js';
import { checkDarkMode } from './checks/dark-mode.js';
import { checkHtmlMeta } from './checks/html-meta.js';
import { checkLicenseMit } from './checks/license-mit.js';
import { checkManifest } from './checks/manifest.js';
import { checkMaskableIcon } from './checks/pwa-maskable-icon.js';
import { checkNoBrandOverrides } from './checks/no-brand-overrides.js';
import { checkNoEnvProduction } from './checks/no-env-production.js';
import { checkNoPlaceholders } from './checks/no-placeholders.js';
import { checkNoScroll } from './checks/no-scroll.js';
import { checkNoTracking } from './checks/no-tracking.js';
import { checkPwaMeta } from './checks/pwa-meta.js';
import { checkPwaOffline } from './checks/pwa-offline.js';
import { checkStoreLink } from './checks/store-link.js';
import { checkUnsafeVh } from './checks/unsafe-vh.js';
import { checkViewportSupport } from './checks/viewport-support.js';
import { type FileSource, fsFileSource, mapFileSource } from './lib/file-source.js';
import { isGameProject } from './lib/project-type.js';
import { CHECKS, annotate, annotateByName, getCheckMeta, getCheckMetaForName, citationsFor, clauseUrl, complianceMap, STANDARD_BASE_URL } from './clause-map.js';
import type { CheckResult } from './types.js';

export type { FileSource } from './lib/file-source.js';
export type { LiveAuditInput, LiveAuditReport } from './live/index.js';
// Live-URL audit (used by the compliance audit Worker; runs in
// browser/Workers env, no filesystem). Separate export path so callers
// don't accidentally pull node:fs in via the file-walking checks.
export {
  auditLive,
  checkBrandFontsLive,
  checkBundleSizeLive,
  checkManifestLive,
  checkNoTrackingLive,
  checkUnsafeVhLive,
} from './live/index.js';
export type { CheckAutomation, CheckResult, CheckStatus, EvidenceClass, StandardCitation } from './types.js';
export type { CheckMeta } from './clause-map.js';
export { CHECKS, annotate, annotateByName, getCheckMeta, getCheckMetaForName, citationsFor, clauseUrl, complianceMap, STANDARD_BASE_URL };
export {
  checkAccessibilityStatic,
  checkBrandFonts,
  checkBrandTokens,
  checkBundleSize,
  checkClaudeMdSlim,
  checkDarkMode,
  checkHtmlMeta,
  checkLicenseMit,
  checkManifest,
  checkMaskableIcon,
  checkNoBrandOverrides,
  checkNoEnvProduction,
  checkNoPlaceholders,
  checkNoScroll,
  checkNoTracking,
  checkPwaMeta,
  checkPwaOffline,
  checkStoreLink,
  checkUnsafeVh,
  checkViewportSupport,
  fsFileSource,
  isGameProject,
  mapFileSource,
};

/**
 * Runs every compliance check against the source. Two front doors:
 *   - `runChecks(repoDir)`        — CLI / CI; reads from disk.
 *   - `runChecksFromFiles(map)`   — VibeCode agent; reads from a Map.
 *
 * Both call the same underlying check functions via the FileSource
 * abstraction, so rules stay in one place. Results are returned in a
 * stable order so callers can render predictable output.
 */
export async function runChecks(repoDir: string): Promise<CheckResult[]> {
  return runChecksOn(fsFileSource(repoDir));
}

export async function runChecksFromFiles(files: Map<string, string>): Promise<CheckResult[]> {
  return runChecksOn(mapFileSource(files));
}

/**
 * Source-side checks in their stable output order, keyed by the id each result
 * is decorated with (#166). Adding a check means adding it here AND to
 * clause-map.ts; clause-map.test.ts fails on either half missing.
 */
const RUNNERS: ReadonlyArray<{ id: string; run: (source: FileSource) => Promise<CheckResult> }> = [
  { id: 'license-mit', run: checkLicenseMit },
  { id: 'no-env-production', run: checkNoEnvProduction },
  { id: 'no-placeholders', run: checkNoPlaceholders },
  { id: 'no-tracking', run: checkNoTracking },
  { id: 'brand-fonts', run: checkBrandFonts },
  { id: 'brand-tokens', run: checkBrandTokens },
  { id: 'no-brand-overrides', run: checkNoBrandOverrides },
  { id: 'no-scroll', run: checkNoScroll },
  { id: 'viewport-support', run: checkViewportSupport },
  { id: 'unsafe-vh', run: checkUnsafeVh },
  { id: 'accessibility-static', run: checkAccessibilityStatic },
  { id: 'html-meta', run: checkHtmlMeta },
  { id: 'pwa-meta', run: checkPwaMeta },
  { id: 'pwa-offline', run: checkPwaOffline },
  { id: 'pwa-manifest', run: checkManifest },
  { id: 'pwa-maskable-icon', run: checkMaskableIcon },
  { id: 'store-link', run: checkStoreLink },
  { id: 'dark-mode', run: checkDarkMode },
  { id: 'bundle-size', run: checkBundleSize },
  { id: 'claude-md-slim', run: checkClaudeMdSlim },
];

/** Ids of the source-side checks, in output order. */
export const SOURCE_CHECK_IDS: readonly string[] = RUNNERS.map((r) => r.id);

async function runChecksOn(source: FileSource): Promise<CheckResult[]> {
  return Promise.all(
    RUNNERS.map(async ({ id, run }) => {
      const meta = getCheckMeta(id);
      if (!meta) throw new Error(`compliance check ${id} has no clause mapping (clause-map.ts)`);
      return annotate(await run(source), meta);
    }),
  );
}
