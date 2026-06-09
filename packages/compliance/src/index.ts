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
export type { CheckResult, CheckStatus } from './types.js';
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

async function runChecksOn(source: FileSource): Promise<CheckResult[]> {
  return Promise.all([
    checkLicenseMit(source),
    checkNoEnvProduction(source),
    checkNoPlaceholders(source),
    checkNoTracking(source),
    checkBrandFonts(source),
    checkBrandTokens(source),
    checkNoBrandOverrides(source),
    checkNoScroll(source),
    checkViewportSupport(source),
    checkUnsafeVh(source),
    checkAccessibilityStatic(source),
    checkHtmlMeta(source),
    checkPwaMeta(source),
    checkPwaOffline(source),
    checkManifest(source),
    checkMaskableIcon(source),
    checkStoreLink(source),
    checkDarkMode(source),
    checkBundleSize(source),
    checkClaudeMdSlim(source),
  ]);
}
