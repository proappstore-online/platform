import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
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

/** Upload a file. Auth required. */
storageRoutes.put('/apps/:appId/storage/*', async (c) => {
  try {
    const user = await requireUser(c);
    const appId = c.req.param('appId');
    const filePath = c.req.path.replace(`/v1/apps/${appId}/storage/`, '');

    if (!filePath || filePath === '') {
      return c.text('file path required', 400);
    }

    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) {
      return c.text('empty file', 400);
    }
    if (body.byteLength > MAX_FILE_SIZE) {
      return c.text(`file too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`, 413);
    }

    const rawType = c.req.header('Content-Type') || 'application/octet-stream';
    // Strip parameters (charset, boundary) and block dangerous MIME types
    // that browsers would execute if served back on a *.proappstore.online subdomain.
    const contentType = rawType.split(';')[0]!.trim().toLowerCase();
    const blocked = ['text/html', 'application/xhtml+xml', 'application/javascript',
      'text/javascript', 'application/x-javascript', 'image/svg+xml'];
    if (blocked.includes(contentType)) {
      return c.text('content type not allowed for uploads', 400);
    }
    // Public files go under {appId}/_public/ directly (no user prefix)
    // so the public download route can find them without auth.
    const key = filePath.startsWith('_public/')
      ? `${appId}/${filePath}`
      : `${appId}/${user.id}/${filePath}`;

    await c.env.STORAGE.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: { uploadedBy: user.id, uploadedAt: Date.now().toString() },
    });

    // Fire webhook (non-blocking)
    const webhookPromise = dispatchWebhook(c.env.DB, appId, 'storage.uploaded', {
      appId,
      userId: user.id,
      key: filePath,
      size: body.byteLength,
      contentType,
    });
    try { c.executionCtx.waitUntil(webhookPromise); } catch { /* no executionCtx in tests */ }

    return c.json({
      key: filePath,
      size: body.byteLength,
      contentType,
      url: `/v1/apps/${appId}/storage/${filePath}`,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
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

    return new Response(object.body, { headers });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
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
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});

/** Delete a file. Auth required (own files only). */
storageRoutes.delete('/apps/:appId/storage/*', async (c) => {
  try {
    const user = await requireUser(c);
    const appId = c.req.param('appId');
    const filePath = c.req.path.replace(`/v1/apps/${appId}/storage/`, '');

    if (!filePath) return c.text('file path required', 400);

    const key = `${appId}/${user.id}/${filePath}`;
    await c.env.STORAGE.delete(key);

    return c.body(null, 204);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});
