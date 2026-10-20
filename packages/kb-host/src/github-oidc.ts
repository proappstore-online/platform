/**
 * GitHub Actions OIDC verification lives in @proappstore/build-core (#430): one
 * copy for every worker that authenticates a workflow (kb-host and the API). Re-exported
 * here so this package's imports, and its tests' module mocks, are unchanged.
 */
export { _resetJwksCache, verifyGithubOidc, type OidcClaims, type VerifyOptions } from '@proappstore/build-core';
