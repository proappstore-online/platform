// Pure, side-effect-free helpers for the PAS build container (ADR-006, Phase 1).
// Kept separate from build.mjs (which shells out to git/pnpm/aws) so the logic
// that actually matters — layout detection, the R2 destination, job validation —
// is unit-testable without a network, a repo, or a container.

/**
 * Layout-adaptive build-output location, matching the canonical deploy workflow:
 * agents author either a flat Vite app (build → `dist`) or a `web/` sub-package
 * (build → `web/dist`). `dirExists` is injected for testability.
 *
 * @param {(path: string) => boolean} dirExists
 * @returns {string} the build-output dir relative to the repo root
 */
export function locateDist(dirExists) {
  if (dirExists('web/dist')) return 'web/dist';
  if (dirExists('dist')) return 'dist';
  throw new Error('No build output (looked for ./dist and ./web/dist)');
}

/**
 * R2 destination for an app's built assets. Matches the path the host Worker
 * serves from today: `pas-apps/apps/<appId>/`.
 *
 * @param {string} bucket
 * @param {string} appId
 * @returns {string} an s3:// URI with a trailing slash
 */
export function r2Destination(bucket, appId) {
  if (!bucket) throw new Error('bucket is required');
  if (!isValidAppId(appId)) throw new Error(`invalid appId: ${JSON.stringify(appId)}`);
  return `s3://${bucket}/apps/${appId}/`;
}

/** App ids are lowercase letters/digits/hyphens, ≤ 58 chars (matches the CLI). */
export function isValidAppId(appId) {
  return typeof appId === 'string' && /^[a-z][a-z0-9-]*$/.test(appId) && appId.length <= 58;
}

/** A 40-hex git sha (the pushed commit the build pins to). */
export function isValidSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha);
}

/**
 * Validate + normalize a build job from the container's environment. The
 * orchestrator (Phase 2) passes these per job. Throws on any missing/invalid
 * field so a malformed job fails fast and loud instead of half-building.
 *
 * @param {Record<string, string | undefined>} env
 */
export function parseJob(env) {
  const repo = env.BUILD_REPO; // "owner/name"
  const sha = env.BUILD_SHA;
  const appId = env.BUILD_APP_ID;
  const bucket = env.R2_BUCKET || 'pas-apps';

  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`BUILD_REPO must be "owner/name", got ${JSON.stringify(repo)}`);
  }
  if (!isValidSha(sha)) throw new Error(`BUILD_SHA must be a 40-hex sha, got ${JSON.stringify(sha)}`);
  if (!isValidAppId(appId)) throw new Error(`BUILD_APP_ID invalid, got ${JSON.stringify(appId)}`);

  return { repo, sha, appId, bucket, destination: r2Destination(bucket, appId) };
}

/**
 * Build the authenticated clone URL from a GitHub App installation token. The
 * token is short-lived (≤ 1h) and scoped to the single repo by the orchestrator,
 * so even leaked build logs can't reuse it broadly. NEVER log the returned URL.
 *
 * @param {string} repo  "owner/name"
 * @param {string} token installation access token
 */
export function cloneUrl(repo, token) {
  if (!token) throw new Error('installation token is required');
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}
