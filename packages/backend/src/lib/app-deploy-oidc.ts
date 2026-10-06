/**
 * The keyless app-deploy check (#253): the request carries a GitHub Actions OIDC
 * token from the app's own repo, on its main branch. The same rule the three
 * routes in routes/deploy.ts apply inline (`deploy-credentials`, `tools/oidc`,
 * `migrate/oidc`); new deploy routes use this helper instead of a fourth copy.
 */
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from './auth.js';
import { verifyGithubOidc, type OidcClaims } from './github-oidc.js';

export const APP_ORG = 'proappstore-online';
/** Audience the canonical deploy workflow requests its OIDC token for. */
export const APP_DEPLOY_AUDIENCE = 'https://api.proappstore.online';
export const APP_DEPLOY_REF = 'refs/heads/main';
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The verified claims, or an HttpError: 400 bad app id, 401 missing/invalid token, 403 wrong repo or ref. */
export async function requireAppDeployOidc(c: Context<{ Bindings: Env }>, appId: string): Promise<OidcClaims> {
  if (!APP_ID_PATTERN.test(appId) || appId.length > 58) throw new HttpError('invalid app id', 400);
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) throw new HttpError('missing OIDC token', 401);
  let claims: OidcClaims;
  try {
    claims = await verifyGithubOidc(token, { audience: APP_DEPLOY_AUDIENCE });
  } catch (e) {
    throw new HttpError(`OIDC verification failed: ${(e as Error).message}`, 401);
  }
  if (claims.repository !== `${APP_ORG}/${appId}`) {
    throw new HttpError(`repository ${claims.repository} is not authorized for app ${appId}`, 403);
  }
  if (claims.ref !== APP_DEPLOY_REF) {
    throw new HttpError(`ref ${claims.ref ?? '(none)'} not authorized — deploys must run from ${APP_DEPLOY_REF}`, 403);
  }
  return claims;
}
