/**
 * Marketing-site deploys (#399): upload, activation and rollback of the static
 * site the storefront's Astro build produces for `about-<appId>.proappstore.online`.
 *
 *   PUT  /v1/apps/:appId/marketing/revisions/:revision   storefront workflow (OIDC); multipart artifact
 *   POST /v1/apps/:appId/marketing/activate              storefront workflow (OIDC); { revision }
 *   POST /v1/apps/:appId/marketing/rollback              storefront workflow (OIDC) or a platform admin; { revision? }
 *   GET  /v1/apps/:appId/marketing/deployments           the app owner or a platform admin: receipts
 *
 * Trust. Only one workflow may write: `.github/workflows/marketing-deploy.yml`
 * in `proappstore-online/proappstore` (pinned by repository, repository and
 * owner IDs) on main, with a token minted for a marketing-only audience. That
 * token is useless at every app-deploy route, and an app repository's token is
 * useless here. No standing secret is involved.
 *
 * Upload writes `marketing/<appId>/revisions/<revision>/` in pas-apps only after
 * every file matches the manifest's size and SHA-256, and never activates. A
 * revision is immutable. Activation re-reads and re-hashes the stored artifact,
 * refuses an unlisted or private app, then switches the host's one pointer —
 * `app_marketing_sites.active_revision` — in a single statement. A failed
 * upload, a bad manifest or a failed verification leaves the pointer alone,
 * so the previous site keeps serving. Rollback re-verifies its target first.
 */

import { Hono, type Context } from 'hono';
import { HttpError, requireAdmin, requireAppOwner } from '../lib/auth.js';
import { verifyGithubOidc, type OidcClaims } from '../lib/github-oidc.js';
import {
  MANIFEST_FILE,
  MARKETING_REVISION_RE,
  MAX_ARTIFACT_BYTES,
  marketingPrefix,
  parseArtifactManifest,
  sha256Hex,
  verifyStoredArtifact,
} from '../lib/marketing-artifact.js';
import { privateNoStore } from '../lib/route-wrap.js';
import type { Env } from '../types.js';

export const STOREFRONT_REPOSITORY = 'proappstore-online/proappstore';
export const STOREFRONT_REPOSITORY_ID = '1228358346';
export const STOREFRONT_OWNER_ID = '281497052';
export const MARKETING_WORKFLOW_REF = `${STOREFRONT_REPOSITORY}/.github/workflows/marketing-deploy.yml@refs/heads/main`;
/** Distinct from the app-deploy audience, so neither token works at the other's routes. */
export const MARKETING_AUDIENCE = 'https://api.proappstore.online/marketing';
const APP_ID_RE = /^[a-z][a-z0-9-]*$/;

export const marketingDeployRoutes = new Hono<{ Bindings: Env }>();
marketingDeployRoutes.use('/apps/:appId/marketing/*', privateNoStore);

function bearer(c: Context<{ Bindings: Env }>): string {
  const auth = c.req.header('Authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

/** The issuer a JWT claims, unverified — only to pick which verifier runs. */
function claimedIssuer(token: string): unknown {
  try {
    const part = token.split('.')[1] ?? '';
    return (JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { iss?: unknown }).iss;
  } catch {
    return undefined;
  }
}

/** The verified claims of the storefront's marketing workflow, or an HttpError (401 token, 403 claims). */
export async function requireMarketingWorkflow(c: Context<{ Bindings: Env }>): Promise<OidcClaims> {
  const token = bearer(c);
  if (!token) throw new HttpError('missing OIDC token', 401);
  let claims: OidcClaims;
  try {
    claims = await verifyGithubOidc(token, { audience: MARKETING_AUDIENCE });
  } catch (e) {
    throw new HttpError(`OIDC verification failed: ${(e as Error).message}`, 401);
  }
  if (claims.repository !== STOREFRONT_REPOSITORY || claims.repository_id !== STOREFRONT_REPOSITORY_ID
    || claims.repository_owner_id !== STOREFRONT_OWNER_ID) {
    throw new HttpError(`repository ${claims.repository} may not deploy marketing sites`, 403);
  }
  if (claims.ref !== 'refs/heads/main') throw new HttpError('marketing deploys must run from refs/heads/main', 403);
  if (claims.workflow_ref !== MARKETING_WORKFLOW_REF) throw new HttpError('this workflow may not deploy marketing sites', 403);
  return claims;
}

function appIdParam(c: Context<{ Bindings: Env }>): string {
  const appId = c.req.param('appId')!;
  if (!APP_ID_RE.test(appId) || appId.length > 57 || appId.startsWith('about-')) throw new HttpError('invalid app id', 400);
  return appId;
}

function revisionOf(value: unknown): string {
  if (typeof value !== 'string' || !MARKETING_REVISION_RE.test(value)) throw new HttpError('invalid revision', 400);
  return value;
}

function bucket(env: Env): R2Bucket {
  if (!env.APPS) throw new HttpError('marketing artifact storage is not configured', 503);
  return env.APPS;
}

interface DeployRow {
  revision: string;
  status: 'uploading' | 'uploaded' | 'failed';
  manifest_sha256: string;
}

async function deployRow(db: D1Database, appId: string, revision: string): Promise<DeployRow | null> {
  return db.prepare('SELECT revision, status, manifest_sha256 FROM app_marketing_deploys WHERE app_id = ? AND revision = ?')
    .bind(appId, revision).first<DeployRow>();
}

async function activeRevision(db: D1Database, appId: string): Promise<string | null> {
  const row = await db.prepare('SELECT active_revision FROM app_marketing_sites WHERE app_id = ?').bind(appId).first<{ active_revision: string | null }>();
  return row?.active_revision ?? null;
}

/** Null when the app may have a public marketing site; otherwise why not. */
async function ineligibility(db: D1Database, appId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT p.listed, v.mode FROM apps a
       LEFT JOIN app_storefront_publication p ON p.app_id = a.id
       LEFT JOIN app_visibility v ON v.app_id = a.id
      WHERE a.id = ?`,
  ).bind(appId).first<{ listed: number | null; mode: string | null }>();
  if (!row) return 'app not found';
  if (row.mode === 'private') return 'a private app cannot have a public marketing site';
  if (row.listed !== 1) return 'the app is not listed on the storefront';
  return null;
}

/** Re-verify a recorded, fully uploaded revision; 404 unknown, 409 not uploaded or not intact, 503 R2. */
async function requireIntact(env: Env, appId: string, revision: string): Promise<void> {
  const row = await deployRow(env.DB, appId, revision);
  if (!row) throw new HttpError('no such marketing revision', 404);
  if (row.status !== 'uploaded') throw new HttpError(`revision ${revision} is ${row.status}, not uploaded`, 409);
  let problem: string | null;
  try {
    problem = await verifyStoredArtifact(bucket(env), appId, revision, row.manifest_sha256);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError('marketing artifact storage unavailable', 503);
  }
  if (problem) throw new HttpError(`artifact verification failed: ${problem}`, 409);
}

/** The one atomic switch the host reads, and the receipt's activation time. */
async function switchActive(db: D1Database, appId: string, revision: string, previous: string | null): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare(
      `INSERT INTO app_marketing_sites (app_id, active_revision, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(app_id) DO UPDATE SET active_revision = excluded.active_revision, updated_at = excluded.updated_at`,
    ).bind(appId, revision, now),
    db.prepare('UPDATE app_marketing_deploys SET activated_at = ?3, updated_at = ?3 WHERE app_id = ?1 AND revision = ?2').bind(appId, revision, now),
  ]);
  console.log(`[marketing] app=${appId} active=${revision} previous=${previous ?? '-'}`);
}

marketingDeployRoutes.put('/apps/:appId/marketing/revisions/:revision', async (c) => {
  const appId = appIdParam(c);
  const revision = revisionOf(c.req.param('revision'));
  const claims = await requireMarketingWorkflow(c);
  const store = bucket(c.env);

  if (Number(c.req.header('content-length') ?? 0) > MAX_ARTIFACT_BYTES + 1024 * 1024) throw new HttpError('artifact too large', 413);
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw new HttpError('expected a multipart/form-data artifact', 400);
  }
  const manifestPart = form.get('manifest') as Blob | string | null;
  if (manifestPart === null) throw new HttpError('missing manifest part', 400);
  const manifestText = typeof manifestPart === 'string' ? manifestPart : await manifestPart.text();
  const manifest = parseArtifactManifest(manifestText, appId, revision);
  if (typeof manifest === 'string') throw new HttpError(manifest, 400);

  // Exactly the manifest's files, each matching its recorded size and hash.
  const expected = new Set(manifest.files.map((f) => f.path));
  for (const name of form.keys()) {
    if (name !== 'manifest' && !expected.has(name)) throw new HttpError(`file not in the manifest: ${name.slice(0, 100)}`, 400);
  }
  const bodies = new Map<string, ArrayBuffer>();
  for (const file of manifest.files) {
    const parts = form.getAll(file.path) as (Blob | string)[];
    const part = parts[0];
    if (parts.length !== 1 || typeof part === 'string' || !part) throw new HttpError(`missing file: ${file.path}`, 400);
    const bytes = await part.arrayBuffer();
    if (bytes.byteLength !== file.size || (await sha256Hex(bytes)) !== file.sha256) throw new HttpError(`file does not match its manifest: ${file.path}`, 400);
    bodies.set(file.path, bytes);
  }
  const manifestBytes = new TextEncoder().encode(manifestText);
  const manifestSha = await sha256Hex(manifestBytes);
  const totalBytes = manifest.files.reduce((n, f) => n + f.size, 0);

  // Reserve the revision before writing a byte. The same artifact again is a
  // no-op (a re-run); different bytes under a recorded revision are refused.
  const now = Date.now();
  const reserved = await c.env.DB.prepare(
    `INSERT INTO app_marketing_deploys (app_id, revision, status, manifest_sha256, file_count, total_bytes, repository, workflow_ref, run_id, commit_sha, created_at, updated_at)
     SELECT ?1, ?2, 'uploading', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10 WHERE EXISTS (SELECT 1 FROM apps WHERE id = ?1)
     ON CONFLICT(app_id, revision) DO UPDATE SET status = 'uploading', error = NULL, updated_at = excluded.updated_at,
       run_id = excluded.run_id, commit_sha = excluded.commit_sha
       WHERE app_marketing_deploys.status IN ('uploading', 'failed') AND app_marketing_deploys.manifest_sha256 = excluded.manifest_sha256
     RETURNING status`,
  ).bind(appId, revision, manifestSha, manifest.files.length, totalBytes, claims.repository,
    String(claims.workflow_ref ?? ''), String(claims.run_id ?? ''), claims.sha ?? null, now).first<{ status: string }>();
  if (!reserved) {
    const existing = await deployRow(c.env.DB, appId, revision);
    if (!existing) throw new HttpError('app not found', 404);
    if (existing.status === 'uploaded' && existing.manifest_sha256 === manifestSha) {
      return c.json({ appId, revision, status: 'uploaded', manifestSha256: manifestSha, unchanged: true });
    }
    throw new HttpError(`revision ${revision} was already uploaded with different content`, 409);
  }

  const prefix = marketingPrefix(appId, revision);
  try {
    for (const file of manifest.files) {
      await store.put(prefix + file.path.slice(1), bodies.get(file.path)!, { httpMetadata: { contentType: file.contentType }, sha256: file.sha256 });
    }
    // The manifest goes last: its presence marks a complete upload.
    await store.put(prefix + MANIFEST_FILE, manifestBytes, { httpMetadata: { contentType: 'application/json; charset=utf-8' }, sha256: manifestSha });
  } catch (e) {
    await c.env.DB.prepare("UPDATE app_marketing_deploys SET status = 'failed', error = ?3, updated_at = ?4 WHERE app_id = ?1 AND revision = ?2")
      .bind(appId, revision, `upload failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`, Date.now()).run().catch(() => {});
    throw new HttpError('marketing artifact storage unavailable', 503);
  }
  await c.env.DB.prepare("UPDATE app_marketing_deploys SET status = 'uploaded', updated_at = ?3 WHERE app_id = ?1 AND revision = ?2")
    .bind(appId, revision, Date.now()).run();
  return c.json({ appId, revision, status: 'uploaded', manifestSha256: manifestSha, files: manifest.files.length, bytes: totalBytes }, 201);
});

marketingDeployRoutes.post('/apps/:appId/marketing/activate', async (c) => {
  const appId = appIdParam(c);
  await requireMarketingWorkflow(c);
  const body = await c.req.json<{ revision?: unknown }>().catch(() => null);
  const revision = revisionOf(body?.revision);

  const previous = await activeRevision(c.env.DB, appId);
  if (previous === revision) return c.json({ appId, active: revision, previous, unchanged: true });
  const refused = await ineligibility(c.env.DB, appId);
  if (refused) throw new HttpError(refused, refused === 'app not found' ? 404 : 409);
  await requireIntact(c.env, appId, revision);
  await switchActive(c.env.DB, appId, revision, previous);
  return c.json({ appId, active: revision, previous });
});

/**
 * Back to a known-good revision: the one named, or the most recently active
 * one before the current. Only while a site is live — an unpublished site is
 * republished through activation, not resurrected by a rollback.
 */
marketingDeployRoutes.post('/apps/:appId/marketing/rollback', async (c) => {
  const appId = appIdParam(c);
  const token = bearer(c);
  if (token && claimedIssuer(token) === 'https://token.actions.githubusercontent.com') await requireMarketingWorkflow(c);
  else await requireAdmin(c);
  const body = await c.req.json<{ revision?: unknown }>().catch(() => null);

  const current = await activeRevision(c.env.DB, appId);
  if (!current) throw new HttpError('no marketing site is active; publish one instead', 409);
  let target: string;
  if (body?.revision !== undefined) {
    target = revisionOf(body.revision);
  } else {
    const prior = await c.env.DB.prepare(
      `SELECT revision FROM app_marketing_deploys
        WHERE app_id = ? AND revision != ? AND status = 'uploaded' AND activated_at IS NOT NULL
        ORDER BY activated_at DESC LIMIT 1`,
    ).bind(appId, current).first<{ revision: string }>();
    if (!prior) throw new HttpError('no earlier revision to roll back to', 409);
    target = prior.revision;
  }
  if (target === current) return c.json({ appId, active: current, previous: current, unchanged: true });
  const refused = await ineligibility(c.env.DB, appId);
  if (refused) throw new HttpError(refused, refused === 'app not found' ? 404 : 409);
  await requireIntact(c.env, appId, target);
  await switchActive(c.env.DB, appId, target, current);
  return c.json({ appId, active: target, previous: current, rolledBack: true });
});

marketingDeployRoutes.get('/apps/:appId/marketing/deployments', async (c) => {
  const appId = appIdParam(c);
  await requireAppOwner(c, appId);
  const active = await activeRevision(c.env.DB, appId);
  const rows = await c.env.DB.prepare(
    `SELECT revision, status, manifest_sha256, file_count, total_bytes, repository, run_id, commit_sha, error, created_at, updated_at, activated_at
       FROM app_marketing_deploys WHERE app_id = ? ORDER BY created_at DESC LIMIT 50`,
  ).bind(appId).all<Record<string, unknown>>();
  return c.json({ active, deployments: (rows.results ?? []).map((r) => ({ ...r, active: r.revision === active })) });
});
