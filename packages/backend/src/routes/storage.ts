import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, requireAppAccess, requireAppOwner, HttpError } from '../lib/auth.js';
import { dispatchWebhook } from '../lib/webhook-dispatch.js';

/**
 * File storage routes — shared R2 bucket, scoped by app + user.
 *
 * File key format: {appId}/{userId}/{path}
 * Users can only read/write files under their own prefix.
 * Public files use a separate prefix: {appId}/_public/{path}
 *
 * Limits:
 * - 50MB max file size
 * - 1000 files per user per app
 */
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export const storageRoutes = new Hono<{ Bindings: Env }>();

/** Upload a file. Auth required. App owner required for _public/ writes. */
storageRoutes.put('/apps/:appId/storage/*', async (c) => {
  try {
    const appId = c.req.param('appId');
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
    //   <path>          → any signed-in user; private, namespaced by their id.
    let user;
    let storageKey: string;
    let returnedKey: string;
    if (filePath.startsWith('_userpub/')) {
      user = await requireUser(c);
      const rest = filePath.slice('_userpub/'.length);
      if (!rest) return c.text('file path required', 400);
      storageKey = `${appId}/_public/u/${user.id}/${rest}`;
      returnedKey = `u/${user.id}/${rest}`;
    } else if (filePath.startsWith('_public/')) {
      user = await requireAppOwner(c, appId);
      storageKey = `${appId}/${filePath}`;
      returnedKey = filePath;
    } else {
      user = await requireUser(c);
      storageKey = `${appId}/${user.id}/${filePath}`;
      returnedKey = filePath;
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
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** Download a public file. No auth required. Key: {appId}/_public/{path} */
storageRoutes.get('/apps/:appId/public/*', async (c) => {
  const appId = c.req.param('appId');
  const filePath = c.req.path.replace(`/v1/apps/${appId}/public/`, '');
  if (!filePath) return c.text('file path required', 400);

  const key = `${appId}/_public/${filePath}`;
  const object = await c.env.STORAGE.get(key);
  if (!object) return c.text('not found', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  // Never let the browser sniff a user-uploaded blob into an executable type
  // (e.g. HTML/JS) on the API origin.
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
});

/** Download a private file. Auth required (reads own files). */
storageRoutes.get('/apps/:appId/storage/*', async (c) => {
  try {
    const user = await requireUser(c);
    const appId = c.req.param('appId');
    const filePath = c.req.path.replace(`/v1/apps/${appId}/storage/`, '');

    if (!filePath) return c.text('file path required', 400);

    const key = `${appId}/${user.id}/${filePath}`;
    const object = await c.env.STORAGE.get(key);

    if (!object) return c.text('not found', 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    headers.set('x-content-type-options', 'nosniff');

    return new Response(object.body, { headers });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** List files. Auth required. */
storageRoutes.get('/apps/:appId/files', async (c) => {
  try {
    const user = await requireUser(c);
    const appId = c.req.param('appId');
    const prefix = `${appId}/${user.id}/`;

    const listed = await c.env.STORAGE.list({ prefix, limit: 1000 });

    const files = listed.objects.map((obj) => ({
      key: obj.key.slice(prefix.length),
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
    }));

    return c.json({ files, count: files.length });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Delete a file. Namespacing mirrors the PUT route (#207):
 *   _userpub/<path>          → the caller's own user-public file; the id comes from the session.
 *   _public/u/<uid>/<path>   → any user's public upload, for team takedowns (team admin+).
 *   _public/<path>           → an owner-curated public asset (app owner).
 *   <path>                   → the caller's own private file.
 * A missing object is a 404, never a silent 204, so a wrong key is visible.
 */
storageRoutes.delete('/apps/:appId/storage/*', async (c) => {
  try {
    const appId = c.req.param('appId');
    const filePath = c.req.path.replace(`/v1/apps/${appId}/storage/`, '');

    if (!filePath) return c.text('file path required', 400);

    let key: string;
    if (filePath.startsWith('_userpub/')) {
      const user = await requireUser(c);
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
      const user = await requireUser(c);
      key = `${appId}/${user.id}/${filePath}`;
    }

    if (!(await c.env.STORAGE.head(key))) return c.text('not found', 404);
    await c.env.STORAGE.delete(key);

    return c.body(null, 204);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
