/**
 * Shared settings of the Cloudflare-runtime integration suite (#129).
 *
 * The compatibility date is the newest the bundled workerd (miniflare 4.20250906)
 * supports; production runs a later one, which the config-drift test asserts is
 * not older than this.
 */
export const COMPATIBILITY_DATE = '2025-09-01';
export const SESSION_SIGNING_KEY = 'runtime-test-signing-key';
export const INTERNAL_TOKEN = 'runtime-test-internal-token';
