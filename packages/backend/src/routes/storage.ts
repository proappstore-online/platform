import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireAppAccess, requireAppOwner, HttpError, type FasUser } from '../lib/auth.js';
import { wrap } from '../lib/route-wrap.js';
import { holdsReviewRole, recordReviewAccess, REVIEW_CONTENT_TYPES, REVIEW_ROLE_NAME, reviewRoles } from '../lib/review-access.js';
import { dispatchWebhook } from '../lib/webhook-dispatch.js';
import { requireVisibleCaller, requireVisibleUser, type AppVisibility } from '../lib/visibility.js';
import { DEFAULT_REVIEW_RETENTION_DAYS, MAX_REVIEW_RETENTION_DAYS, reviewRetentionDays } from '../lib/review-storage-reaper.js';

/**
 * File storage routes — shared R2 bucket, scoped by app + user.
 *
 * File key format: {appId}/{userId}/{path}
 * Users can only read/write files under their own prefix.
 * Public files use a separate prefix: {appId}/_public/{path}
 *
 * Limits:
 * - 50MB max file size
 * - 1000 files per user per app in each namespace — private, _userpub,
 *   _review (enforced since #219; owner-curated _public is not counted)
 */
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const MAX_FILES_PER_NAMESPACE = 1000;

/**
 * #219: refuse a NEW file once the caller's namespace holds MAX_FILES_PER_NAMESPACE.
 * A replacement (the key already exists) is always allowed. The count is an R2
 * list on the prefix — authoritative, no counter to backfill or drift. Returns
 * the refusal message, or null to proceed.
 */
export async function fileQuotaRefusal(bucket: R2Bucket, key: string, prefix: string): Promise<string | null> {
  if (await bucket.head(key)) return null;
  const listed = await bucket.list({ prefix, limit: MAX_FILES_PER_NAMESPACE });
  if (listed.objects.length < MAX_FILES_PER_NAMESPACE) return null;
  return `file limit reached (${MAX_FILES_PER_NAMESPACE} files per user per app here); delete files to upload more`;
}

export const storageRoutes = new Hono<{ Bindings: Env }>();

// ── Review uploads (#208) ─────────────────────────────────────────────
// `_review/<path>` stores a private document at {appId}/_review/u/{uid}/<path>.
// Its uploader and holders of the app's declared review roles may read or
// delete it at `_review/u/<uid>/<path>`; nobody else, the app team included.

const MAX_REVIEW_ROLES = 10;

/**
 * Authorize access to `_review/u/<ownerId>/<path>`: the uploader, or a live
 * holder of a declared review role. Throws 400/403; returns the object key.
 * `audit` records a non-uploader's access and must run before the object is
 * served or deleted.
 */
async function authorizeReview(
  c: Context<{ Bindings: Env }>,
  appId: string,
  filePath: string,
  user: FasUser,
): Promise<{ key: string; audit: (action: 'read' | 'delete') => Promise<void> }> {
  const m = /^_review\/u\/([^/]+)\/(.+)$/.exec(filePath);
  if (!m) throw new HttpError('review files are addressed as _review/u/<userId>/<path>', 400);
  const [, rawOwner, path] = m as unknown as [string, string, string];
  // The router leaves reserved characters encoded (gh%3A1): decode the id so it
  // matches the session's user id and the key the upload was stored under.
  let ownerId: string;
  try {
    ownerId = decodeURIComponent(rawOwner);
  } catch {
    throw new HttpError('invalid user id in review path', 400);
  }
  if (!ownerId || ownerId.includes('/')) throw new HttpError('invalid user id in review path', 400);
  const key = `${appId}/_review/u/${ownerId}/${path}`;
  if (ownerId === user.id) return { key, audit: async () => {} };

  if (!(await holdsReviewRole(c.env.DB, appId, user))) throw new HttpError('not a reviewer for this app', 403);
  return { key, audit: (action) => recordReviewAccess(c.env.DB, appId, ownerId, path, user.id, action) };
}

/** Upload a file. Auth required. App owner required for _public/ writes. */
storageRoutes.put('/apps/:appId/storage/*', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  const filePath = c.req.path.replace(`/v1/apps/${appId}/storage/`, '');

  if (!filePath || filePath === '') {
    return c.text('file path required', 400);
  }

  // Auth + key namespacing (checked before reading the body):
  //   _userpub/<path> → ANY signed-in user. Stored public under their own id
  //                     (user-generated content — rating photos, avatars…). The
  //                     id comes from the token, so callers can't spoof or
  //                     overwrite each other, and the file is publicly viewable.
  //   _public/<path>  → app OWNER only (owner-curated public assets).
  //   _review/<path>  → any signed-in user; private, readable by them and the
  //                     app's review-role holders (#208). Documents only.
  //   <path>          → any signed-in user; private, namespaced by their id.
  let user;
  let storageKey: string;
  let returnedKey: string;
  let quotaPrefix: string | null = null; // #219: the caller's namespace; null = not counted
  if (filePath.startsWith('_review/')) {
    user = await requireVisibleUser(c, appId);
    const rest = filePath.slice('_review/'.length);
    if (!rest) return c.text('file path required', 400);
    const type = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!REVIEW_CONTENT_TYPES.has(type)) return c.text(`review uploads must be one of: ${[...REVIEW_CONTENT_TYPES].join(', ')}`, 400);
    storageKey = `${appId}/_review/u/${user.id}/${rest}`;
    returnedKey = `_review/u/${user.id}/${rest}`;
    quotaPrefix = `${appId}/_review/u/${user.id}/`;
  } else if (filePath.startsWith('_userpub/')) {
    user = await requireVisibleUser(c, appId);
    const rest = filePath.slice('_userpub/'.length);
    if (!rest) return c.text('file path required', 400);
    storageKey = `${appId}/_public/u/${user.id}/${rest}`;
    returnedKey = `u/${user.id}/${rest}`;
    quotaPrefix = `${appId}/_public/u/${user.id}/`;
  } else if (filePath.startsWith('_public/')) {
    user = await requireAppOwner(c, appId);
    storageKey = `${appId}/${filePath}`;
    returnedKey = filePath;
  } else {
    user = await requireVisibleUser(c, appId);
    storageKey = `${appId}/${user.id}/${filePath}`;
    returnedKey = filePath;
    quotaPrefix = `${appId}/${user.id}/`;
  }

  // Before the body is read, so a refused upload is never buffered.
  if (quotaPrefix) {
    const refusal = await fileQuotaRefusal(c.env.STORAGE, storageKey, quotaPrefix);
    if (refusal) return c.text(refusal, 403);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) {
    return c.text('empty file', 400);
  }
  if (body.byteLength > MAX_FILE_SIZE) {
    return c.text(`file too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`, 413);
  }

  const rawType = c.req.header('Content-Type') || 'application/octet-stream';
  const contentType = rawType.split(';')[0]!.trim().toLowerCase();
  const blocked = ['text/html', 'application/xhtml+xml', 'application/javascript',
    'text/javascript', 'application/x-javascript', 'image/svg+xml'];
  if (blocked.includes(contentType)) {
    return c.text('content type not allowed for uploads', 400);
  }

  await c.env.STORAGE.put(storageKey, body, {
    httpMetadata: { contentType },
    customMetadata: { uploadedBy: user.id, uploadedAt: Date.now().toString() },
  });

  // Fire webhook (non-blocking)
  const webhookPromise = dispatchWebhook(c.env.DB, appId, 'storage.uploaded', {
    appId,
    userId: user.id,
    key: returnedKey,
    size: body.byteLength,
    contentType,
  });
  try { c.executionCtx.waitUntil(webhookPromise); } catch { /* no executionCtx in tests */ }

  return c.json({
    key: returnedKey,
    size: body.byteLength,
    contentType,
    url: `/v1/apps/${appId}/storage/${returnedKey}`,
  });
}));

/**
 * Content types a browser renders as an active document when opened directly:
 * served from the API origin they could run script there (#216). Uploads refuse
 * most of these, but objects stored before a rule (or by another path) are
 * neutralised at read time instead.
 */
const ACTIVE_DOCUMENT_TYPES = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/xml', 'text/xml']);

/** Download a public file. No auth required. Key: {appId}/_public/{path} */
storageRoutes.get('/apps/:appId/public/*', async (c) => {
  const appId = c.req.param('appId');
  const filePath = c.req.path.replace(`/v1/apps/${appId}/public/`, '');
  if (!filePath) return c.text('file path required', 400);

  // #259: "public" here means "any user of the app" — for a private app, only the
  // callers its visibility gate allows, and never a shared-cacheable response.
  let visibility: AppVisibility;
  try {
    visibility = await requireVisibleCaller(c, appId);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode, { 'cache-control': 'private, no-store' });
    throw err;
  }

  const key = `${appId}/_public/${filePath}`;
  const object = await c.env.STORAGE.get(key);
  if (!object) return c.text('not found', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', visibility.mode === 'private' ? 'private, no-store' : 'public, max-age=31536000, immutable');
  // Never let the browser sniff a user-uploaded blob into an executable type
  // (e.g. HTML/JS) on the API origin.
  headers.set('x-content-type-options', 'nosniff');
  // #216: an active-document type opened directly renders with no script, no
  // plugins and an opaque origin. <img src> of an SVG is unaffected.
  const type = (headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (ACTIVE_DOCUMENT_TYPES.has(type) || /\.svg$/i.test(filePath)) {
    headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
  return new Response(object.body, { headers });
});

/** Download a private file. Auth required (reads own files). */
storageRoutes.get('/apps/:appId/storage/*', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireVisibleUser(c, appId);
  const filePath = c.req.path.replace(`/v1/apps/${appId}/storage/`, '');

  if (!filePath) return c.text('file path required', 400);

  if (filePath.startsWith('_review/')) {
    const review = await authorizeReview(c, appId, filePath, user);
    const object = await c.env.STORAGE.get(review.key);
    if (!object) return c.text('not found', 404);
    await review.audit('read');
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    // Never cached anywhere: a revoked reviewer must not keep a copy.
    headers.set('cache-control', 'private, no-store');
    headers.set('x-content-type-options', 'nosniff');
    headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    return new Response(object.body, { headers });
  }

  const key = `${appId}/${user.id}/${filePath}`;
  const object = await c.env.STORAGE.get(key);

  if (!object) return c.text('not found', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // #220: this is the CALLER's private file, and the URL carries no user id, so
  // two users' files at the same path share a URL. A `public`/`immutable` answer
  // let a browser cache serve one user's file to the next account on that
  // browser, and kept replaced or deleted files alive for a year. Never cached.
  headers.set('cache-control', 'private, no-store');
  headers.set('vary', 'Authorization');
  headers.set('x-content-type-options', 'nosniff');

  return new Response(object.body, { headers });
}));

/** List files. Auth required. */
storageRoutes.get('/apps/:appId/files', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireVisibleUser(c, appId);
  const prefix = `${appId}/${user.id}/`;

  const listed = await c.env.STORAGE.list({ prefix, limit: 1000 });

  const files = listed.objects.map((obj) => ({
    key: obj.key.slice(prefix.length),
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
  }));

  return c.json({ files, count: files.length });
}));

/**
 * Delete a file. Namespacing mirrors the PUT route (#207):
 *   _userpub/<path>          → the caller's own user-public file; the id comes from the session.
 *   _public/u/<uid>/<path>   → any user's public upload, for team takedowns (team admin+).
 *   _public/<path>           → an owner-curated public asset (app owner).
 *   _review/u/<uid>/<path>   → a review upload: its uploader or a review-role holder (#208).
 *   <path>                   → the caller's own private file.
 * A missing object is a 404, never a silent 204, so a wrong key is visible.
 */
storageRoutes.delete('/apps/:appId/storage/*', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  const filePath = c.req.path.replace(`/v1/apps/${appId}/storage/`, '');

  if (!filePath) return c.text('file path required', 400);

  let key: string;
  if (filePath.startsWith('_review/')) {
    const review = await authorizeReview(c, appId, filePath, await requireVisibleUser(c, appId));
    if (!(await c.env.STORAGE.head(review.key))) return c.text('not found', 404);
    await review.audit('delete');
    await c.env.STORAGE.delete(review.key);
    return c.body(null, 204);
  } else if (filePath.startsWith('_userpub/')) {
    const user = await requireVisibleUser(c, appId);
    const rest = filePath.slice('_userpub/'.length);
    if (!rest) return c.text('file path required', 400);
    key = `${appId}/_public/u/${user.id}/${rest}`;
  } else if (filePath.startsWith('_public/u/')) {
    await requireAppAccess(c, appId, 'admin');
    key = `${appId}/${filePath}`;
  } else if (filePath.startsWith('_public/')) {
    await requireAppOwner(c, appId);
    key = `${appId}/${filePath}`;
  } else {
    const user = await requireVisibleUser(c, appId);
    key = `${appId}/${user.id}/${filePath}`;
  }

  if (!(await c.env.STORAGE.head(key))) return c.text('not found', 404);
  await c.env.STORAGE.delete(key);

  return c.body(null, 204);
}));

/** The app's stored review retention (#307): 1–365 days, or null for the platform default. */
async function storedRetention(db: D1Database, appId: string): Promise<number | null> {
  const row = await db.prepare('SELECT review_retention_days FROM app_storage_config WHERE app_id = ?1').bind(appId).first<{ review_retention_days: number | null }>();
  return row?.review_retention_days ?? null;
}

async function storageConfig(db: D1Database, appId: string) {
  const days = await storedRetention(db, appId);
  return { review_roles: await reviewRoles(db, appId), review_retention_days: days, effective_review_retention_days: reviewRetentionDays(days) };
}

/** The app's storage configuration (#208, #307). Any team member may read it. */
storageRoutes.get('/apps/:appId/storage-config', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppAccess(c, appId, 'viewer');
  return c.json(await storageConfig(c.env.DB, appId));
}));

/**
 * Set the app's storage configuration. Team admin only. Either field may be sent
 * alone; an absent field keeps its value.
 *
 * - `review_roles`: which app roles may review `_review/` uploads (#208). `member`
 *   is refused: every signed-in user holds it, so it would make every review
 *   document readable by every user of the app.
 * - `review_retention_days` (#307): delete undecided review uploads after this
 *   many days, 1–365; null restores the platform default (30).
 */
storageRoutes.put('/apps/:appId/storage-config', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  const actor = await requireAppAccess(c, appId, 'admin');
  const body = await c.req.json<{ review_roles?: unknown; review_retention_days?: unknown }>().catch(() => null);
  const setRoles = body !== null && typeof body === 'object' && 'review_roles' in body;
  const setDays = body !== null && typeof body === 'object' && 'review_retention_days' in body;
  if (!setRoles && !setDays) return c.text('body must set review_roles and/or review_retention_days', 400);

  let roles: string[] = [];
  if (setRoles) {
    const raw = body!.review_roles;
    if (!Array.isArray(raw) || raw.length > MAX_REVIEW_ROLES || raw.some((r) => typeof r !== 'string' || !REVIEW_ROLE_NAME.test(r))) {
      return c.text(`review_roles must be an array of up to ${MAX_REVIEW_ROLES} app role names`, 400);
    }
    if (raw.includes('member')) return c.text("review_roles cannot include 'member' (every signed-in user holds it)", 400);
    roles = [...new Set(raw as string[])];
  }
  const days = setDays ? body!.review_retention_days : null;
  if (setDays && days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_REVIEW_RETENTION_DAYS)) {
    return c.text(`review_retention_days must be an integer from 1 to ${MAX_REVIEW_RETENTION_DAYS}, or null for the platform default (${DEFAULT_REVIEW_RETENTION_DAYS})`, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO app_storage_config (app_id, review_roles, review_retention_days, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(app_id) DO UPDATE SET
       review_roles = CASE WHEN ?6 THEN excluded.review_roles ELSE app_storage_config.review_roles END,
       review_retention_days = CASE WHEN ?7 THEN excluded.review_retention_days ELSE app_storage_config.review_retention_days END,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(appId, JSON.stringify(roles), days, actor.id, Date.now(), setRoles ? 1 : 0, setDays ? 1 : 0).run();
  return c.json(await storageConfig(c.env.DB, appId));
}));

/** The audit trail of reviewer reads/deletes of review uploads, newest first. Team admin only. */
storageRoutes.get('/apps/:appId/storage-review-access', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppAccess(c, appId, 'admin');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const owner = c.req.query('owner');
  const { results } = await c.env.DB.prepare(
    `SELECT owner_id, path, actor_id, action, created_at FROM storage_review_access
      WHERE app_id = ?1 ${owner ? 'AND owner_id = ?3' : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?2`,
  ).bind(...(owner ? [appId, limit, owner] : [appId, limit])).all();
  return c.json({ access: results ?? [] });
}));
