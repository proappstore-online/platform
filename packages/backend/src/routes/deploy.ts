import { Hono } from 'hono';
import type { Env } from '../types.js';
import { verifyGithubOidc } from '../lib/github-oidc.js';

/**
 * Keyless deploy credentials.
 *
 * An app repo's GitHub Actions runner authenticates with a GitHub OIDC token
 * (no stored secret) and gets back short-lived R2 credentials scoped to ONLY
 * that app's object prefix. This replaces standing per-repo/org R2 secrets:
 *   - no secret lives in any repo (works on a Free org with private repos),
 *   - one app can never touch another's objects (prefix-scoped),
 *   - credentials expire in minutes; rotation/audit is centralized here.
 *
 * The app id, and therefore the R2 prefix, is derived from the VERIFIED
 * `repository` claim — a repo can only ever mint credentials for its own app.
 */

const ORG = 'proappstore-online';
const BUCKET = 'pas-apps';
/** Audience the deploy workflow must request its OIDC token for. */
const AUDIENCE = 'https://api.proappstore.online';
const TTL_SECONDS = 900; // 15 min — long enough for a build+sync, short-lived.

export const deployRoutes = new Hono<{ Bindings: Env }>();

deployRoutes.post('/apps/:appId/deploy-credentials', async (c) => {
  const appId = c.req.param('appId');
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    return c.json({ error: 'invalid app id' }, 400);
  }

  // 1. GitHub OIDC token from Authorization: Bearer <jwt>
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return c.json({ error: 'missing OIDC token' }, 401);

  // 2. Verify it's a genuine GitHub Actions token for our audience
  let claims;
  try {
    claims = await verifyGithubOidc(token, { audience: AUDIENCE });
  } catch (e) {
    return c.json({ error: `OIDC verification failed: ${(e as Error).message}` }, 401);
  }

  // 3. Authorize: the deploying repo must be this org's repo named exactly the
  //    app id. Since the prefix below is derived from appId and appId must equal
  //    the verified repo name, a repo can only ever mint creds for its own prefix.
  const expected = `${ORG}/${appId}`;
  if (claims.repository !== expected) {
    return c.json({ error: `repository ${claims.repository} is not authorized for app ${appId}` }, 403);
  }

  // 4. Mint short-lived, prefix-scoped R2 credentials via the R2 API.
  const parentKey = c.env.R2_PARENT_ACCESS_KEY_ID;
  if (!parentKey || !c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID) {
    return c.json({ error: 'deploy credential minting not configured' }, 503);
  }
  const prefix = `apps/${appId}/`;

  let result: { accessKeyId: string; secretAccessKey: string; sessionToken: string } | undefined;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/r2/temp-access-credentials`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bucket: BUCKET,
          parentAccessKeyId: parentKey,
          permission: 'object-read-write',
          ttlSeconds: TTL_SECONDS,
          prefixes: [prefix],
        }),
      },
    );
    const data = (await res.json()) as {
      success: boolean;
      result?: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
      errors?: unknown;
    };
    if (!res.ok || !data.success || !data.result) {
      return c.json({ error: 'failed to mint R2 credentials', detail: data.errors ?? `status ${res.status}` }, 502);
    }
    result = data.result;
  } catch (e) {
    return c.json({ error: `R2 credential request failed: ${(e as Error).message}` }, 502);
  }

  return c.json({
    accessKeyId: result.accessKeyId,
    secretAccessKey: result.secretAccessKey,
    sessionToken: result.sessionToken,
    bucket: BUCKET,
    prefix,
    endpoint: `https://${c.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    expiresInSeconds: TTL_SECONDS,
    repository: claims.repository,
    sha: claims.sha ?? null,
  });
});
