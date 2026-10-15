/**
 * Browser source maps (#393, ADR-008 decision 7).
 *
 *   POST /v1/apps/:appId/sourcemaps?commitSha=<40 hex>   the app's deploy, GitHub OIDC
 *   POST /v1/apps/:appId/sourcemaps/:commitSha/symbolicate   the app owner
 *
 * Upload is keyless like the deploy's migrate/worker/tools steps: the token must
 * come from the app's own repository on main, and the commit it names must be the
 * one being uploaded. A release is immutable — a second upload for the same
 * commit is a 409 — and bounded in size, file count and path shape. Maps go to
 * the private STORAGE bucket only. Symbolication returns sanitized frames and an
 * explicit status; it never fetches anything a stack names.
 */

import { Hono } from 'hono';
import { requireAppDeployOidc } from '../lib/app-deploy-oidc.js';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import { privateNoStore } from '../lib/route-wrap.js';
import {
  bundleProblem,
  COMMIT_SHA_RE,
  MAX_BUNDLE_BYTES,
  MAX_FRAMES,
  type RawFrame,
  sourcemapStorageKey,
  SOURCEMAP_RETENTION_MS,
  symbolicateStack,
  uploadSourceMap,
} from '../lib/sourcemap.js';
import type { Env } from '../types.js';

export const sourcemapRoutes = new Hono<{ Bindings: Env }>();
sourcemapRoutes.use('/apps/:appId/sourcemaps', privateNoStore);
sourcemapRoutes.use('/apps/:appId/sourcemaps/*', privateNoStore);

sourcemapRoutes.post('/apps/:appId/sourcemaps', async (c) => {
  const appId = c.req.param('appId');
  const claims = await requireAppDeployOidc(c, appId);
  const commitSha = (c.req.query('commitSha') ?? '').toLowerCase();
  if (!COMMIT_SHA_RE.test(commitSha)) throw new HttpError('commitSha must be a 40-character hex commit SHA', 400);
  // The workflow run's own commit: a repository cannot plant maps for another build.
  if (claims.sha?.toLowerCase() !== commitSha) throw new HttpError('commitSha is not the commit this deploy is running for', 403);

  if (Number(c.req.header('content-length') ?? 0) > MAX_BUNDLE_BYTES) throw new HttpError('source-map bundle too large', 413);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new HttpError('source-map bundle too large', 413);
  const problem = bundleProblem(bytes);
  if (problem) throw new HttpError(problem, 400);

  // Reserve the release first: the UNIQUE key makes it immutable, so a repeat
  // upload is refused before any byte is written over an existing release.
  const now = Date.now();
  const expiresAt = now + SOURCEMAP_RETENTION_MS;
  const storageKey = sourcemapStorageKey(appId, commitSha);
  const reserved = await c.env.DB.prepare(
    `INSERT INTO release_sourcemap_manifests (app_id, commit_sha, asset_digest, storage_key, uploaded_at, expires_at)
     SELECT ?1, ?2, '', ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM apps WHERE id = ?1)
     ON CONFLICT(app_id, commit_sha) DO NOTHING RETURNING id`,
  ).bind(appId, commitSha, storageKey, now, expiresAt).first<{ id: number }>();
  if (!reserved) {
    const exists = await c.env.DB.prepare('SELECT 1 FROM release_sourcemap_manifests WHERE app_id = ? AND commit_sha = ?').bind(appId, commitSha).first();
    throw new HttpError(exists ? 'source maps for this commit were already uploaded' : 'app not found', exists ? 409 : 404);
  }

  try {
    const { assetDigest } = await uploadSourceMap(c.env, appId, commitSha, bytes);
    await c.env.DB.prepare('UPDATE release_sourcemap_manifests SET asset_digest = ? WHERE id = ?').bind(assetDigest, reserved.id).run();
    return c.json({ storageKey, assetDigest, expiresAt }, 201);
  } catch (e) {
    // Release the reservation so the deploy can retry; never leave a row without its bytes.
    await c.env.DB.prepare('DELETE FROM release_sourcemap_manifests WHERE id = ?').bind(reserved.id).run().catch(() => {});
    throw e instanceof HttpError ? e : new HttpError('source-map storage unavailable', 503);
  }
});

sourcemapRoutes.post('/apps/:appId/sourcemaps/:commitSha/symbolicate', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  const commitSha = c.req.param('commitSha').toLowerCase();
  if (!COMMIT_SHA_RE.test(commitSha)) throw new HttpError('commitSha must be a 40-character hex commit SHA', 400);

  const body = await c.req.json<{ frames?: unknown; rawStack?: unknown }>().catch(() => null);
  const frames = parseFrames(body?.frames);
  if (!frames) throw new HttpError(`frames must be 1–${MAX_FRAMES} objects of { source: string, line: integer ≥ 1, col: integer ≥ 1 }`, 400);
  const rawStack = typeof body?.rawStack === 'string' ? body.rawStack.slice(0, 16_384) : undefined;

  const result = await symbolicateStack(c.env, appId, commitSha, frames);
  // The raw stack is kept as the fallback whatever the status.
  return c.json({ ...result, ...(rawStack !== undefined ? { rawStack } : {}) });
});

function parseFrames(value: unknown): RawFrame[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FRAMES) return null;
  const frames: RawFrame[] = [];
  for (const f of value) {
    const { source, line, col } = (f ?? {}) as Record<string, unknown>;
    if (typeof source !== 'string' || source.length === 0 || source.length > 2048) return null;
    if (!Number.isInteger(line) || (line as number) < 1 || !Number.isInteger(col) || (col as number) < 1) return null;
    frames.push({ source, line: line as number, col: col as number });
  }
  return frames;
}
