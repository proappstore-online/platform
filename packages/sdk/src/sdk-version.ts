/**
 * The published SDK version, sent on log entries (#390). The source value is a
 * placeholder: `scripts/stamp-version.mjs` writes the package.json version into
 * dist on build and again on prepack, after publish.yml has bumped it.
 */
export const SDK_VERSION: string = '0.0.0-dev';
