/**
 * Marketing-site deploys (#399, #408): upload, activation and rollback of the
 * static site an app's own deploy builds from its `marketing/` folder, served at
 * `about-<appId>.proappstore.online`.
 *
 *   PUT  /v1/apps/:appId/marketing/revisions/:revision   the app's deploy (OIDC); multipart artifact
 *   POST /v1/apps/:appId/marketing/activate              the app's deploy (OIDC); { revision }
 *   POST /v1/apps/:appId/marketing/rollback              the app's deploy (OIDC) or a platform admin; { revision? }
 *   GET  /v1/apps/:appId/marketing/deployments           the app owner or a platform admin: receipts
 *
 * Trust (#408). The same keyless rule as every other deploy step
 * (lib/app-deploy-oidc.ts): a GitHub Actions OIDC token from the app's own
 * repository on main. A repository can only ever write its own app's site, and
 * an upload's revision is the commit that run is building. No standing secret.
 *
 * Upload writes `marketing/<appId>/revisions/<revision>/` in pas-apps only after
 * every file matches the manifest's size and SHA-256, and never activates. A
 * revision is immutable. Activation re-reads and re-hashes the stored artifact,
 * then switches the host's one pointer —
 * `app_marketing_sites.active_revision` — in a single statement. A failed
 * upload, a bad manifest or a failed verification leaves the pointer alone,
 * so the previous site keeps serving. Rollback re-verifies its target first.
 */

import { Hono, type Context } from 'hono';
import { HttpError, requireAdmin, requireAppOwner } from '../lib/auth.js';
import { requireAppDeployOidc } from '../lib/app-deploy-oidc.js';
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

/** An `uploading` reservation older than this is a dead run, not a concurrent one (#441). */
const STALE_UPLOAD_MS = 15 * 60 * 1000;

/**
 * Before a re-reservation writes, drop whatever an earlier attempt left under the
 * revision prefix: the old manifest first (its presence marks a complete upload),
 * then every object the new manifest does not list.
 */
async function clearStaleObjects(store: R2Bucket, prefix: string, keep: Set<string>): Promise<void> {
  await store.delete(prefix + MANIFEST_FILE);
  let cursor: string | undefined;
  do {
    const page = await store.list(cursor ? { prefix, cursor } : { prefix });
    const stale = page.objects.map((o) => o.key).filter((k) => !keep.has(k));
    if (stale.length) await store.delete(stale);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

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

/** #409: every app may have a public marketing site, private and unlisted ones included. */
async function requireApp(db: D1Database, appId: string): Promise<void> {
  if (!(await db.prepare('SELECT 1 FROM apps WHERE id = ?').bind(appId).first())) throw new HttpError('app not found', 404);
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
  const results = await db.batch([
    db.prepare(
      `INSERT INTO app_marketing_sites (app_id, active_revision, updated_at)
       SELECT ?1, ?2, ?3 WHERE ?4 IS NULL OR EXISTS (
         SELECT 1 FROM app_marketing_sites WHERE app_id = ?1 AND active_revision IS ?4
       )
       ON CONFLICT(app_id) DO UPDATE SET active_revision = excluded.active_revision, updated_at = excluded.updated_at
       WHERE app_marketing_sites.active_revision IS ?4`,
    ).bind(appId, revision, now, previous),
    // D1 batch is transactional; changes() belongs to the immediately preceding switch.
    db.prepare('UPDATE app_marketing_deploys SET activated_at = ?3, updated_at = ?3 WHERE app_id = ?1 AND revision = ?2 AND changes() > 0').bind(appId, revision, now),
  ]);
  if (results[0]?.meta.changes !== 1) throw new HttpError('marketing site changed; refresh deployment state before retrying', 409);
  console.log(`[marketing] app=${appId} active=${revision} previous=${previous ?? '-'}`);
}

marketingDeployRoutes.put('/apps/:appId/marketing/revisions/:revision', async (c) => {
  const appId = appIdParam(c);
  const revision = revisionOf(c.req.param('revision'));
  const claims = await requireAppDeployOidc(c, appId);
  // The revision is the commit this run builds: a repository cannot plant one under another name.
  if (claims.sha?.toLowerCase() !== revision) throw new HttpError('revision must be the commit this deploy is running for', 403);
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
  // no-op (a re-run). Different bytes under a recorded revision are refused —
  // unless that revision never went live and its upload is dead: `failed`, or
  // `uploading` and stale (#441). A re-run of the same commit can legitimately
  // rebuild different bytes (`install --no-frozen-lockfile`), and nothing was
  // published under the old manifest, so the reservation is re-taken with the
  // new one. A live `uploading` row with another manifest is a concurrent run: 409.
  const now = Date.now();
  const reserved = await c.env.DB.prepare(
    `INSERT INTO app_marketing_deploys (app_id, revision, status, manifest_sha256, file_count, total_bytes, repository, workflow_ref, run_id, commit_sha, created_at, updated_at)
     SELECT ?1, ?2, 'uploading', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10 WHERE EXISTS (SELECT 1 FROM apps WHERE id = ?1)
     ON CONFLICT(app_id, revision) DO UPDATE SET status = 'uploading', error = NULL, updated_at = excluded.updated_at,
       run_id = excluded.run_id, commit_sha = excluded.commit_sha,
       manifest_sha256 = excluded.manifest_sha256, file_count = excluded.file_count, total_bytes = excluded.total_bytes
       WHERE app_marketing_deploys.activated_at IS NULL AND (
         (app_marketing_deploys.status IN ('uploading', 'failed') AND app_marketing_deploys.manifest_sha256 = excluded.manifest_sha256)
         OR app_marketing_deploys.status = 'failed'
         OR (app_marketing_deploys.status = 'uploading' AND app_marketing_deploys.updated_at < ?11))
     RETURNING status`,
  ).bind(appId, revision, manifestSha, manifest.files.length, totalBytes, claims.repository,
    String(claims.workflow_ref ?? ''), String(claims.run_id ?? ''), claims.sha ?? null, now, now - STALE_UPLOAD_MS).first<{ status: string }>();
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
    await clearStaleObjects(store, prefix, new Set(manifest.files.map((f) => prefix + f.path.slice(1))));
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
  await requireAppDeployOidc(c, appId);
  const body = await c.req.json<{ revision?: unknown }>().catch(() => null);
  const revision = revisionOf(body?.revision);

  const previous = await activeRevision(c.env.DB, appId);
  if (previous === revision) return c.json({ appId, active: revision, previous, unchanged: true });
  await requireApp(c.env.DB, appId);
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
  if (token && claimedIssuer(token) === 'https://token.actions.githubusercontent.com') await requireAppDeployOidc(c, appId);
  else await requireAdmin(c);
  const body = await c.req.json<{ revision?: unknown; expectedRevision?: unknown }>().catch(() => null);

  const current = await activeRevision(c.env.DB, appId);
  if (!current) throw new HttpError('no marketing site is active; publish one instead', 409);
  if (body?.expectedRevision !== undefined && revisionOf(body.expectedRevision) !== current) {
    throw new HttpError('marketing site changed; refresh deployment state before retrying', 409);
  }
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
  await requireApp(c.env.DB, appId);
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
