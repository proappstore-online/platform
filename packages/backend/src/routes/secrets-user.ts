/**
 * Per-user app secrets (#587): the signed-in user's own keys for one app, used
 * by proxy rules with secretScope 'user'. Only the user can write, list or
 * delete them, and only through the app's own origin, like the proxy. Values
 * are write-only: no response, log or error carries one.
 */
import type { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import { sealUserSecret } from '../lib/user-secrets.js';
import type { Env } from '../types.js';
import { MAX_SECRET_VALUE_CHARS, requireKek, requireMediatedApp, SECRET_NAME_RE, wrap, type Ctx } from './secrets-shared.js';

/** The session user, calling from this app's own origin. */
async function caller(c: Ctx, appId: string) {
  const user = await requireUser(c);
  requireMediatedApp(c, appId, 'user secrets');
  return user;
}

/** Writes per (app, user): USER_SECRET_RATE_LIMIT. */
async function requireWriteRate(c: Ctx, appId: string, userId: string) {
  if (!(await c.env.USER_SECRET_RATE_LIMIT.limit({ key: `${appId}:${userId}` })).success) {
    throw new HttpError('too many user-secret changes; try again in a minute', 429);
  }
}

export function registerUserSecretsRoutes(secretsRoutes: Hono<{ Bindings: Env }>) {
  secretsRoutes.get(
    '/apps/:appId/user-secrets',
    wrap(async (c) => {
      const appId = c.req.param('appId')!;
      const user = await caller(c, appId);
      const result = await c.env.DB.prepare(
        'SELECT name, updated_at, last_used_at FROM app_user_secrets WHERE app_id = ? AND user_id = ? ORDER BY name',
      )
        .bind(appId, user.id)
        .all<{ name: string; updated_at: number; last_used_at: number | null }>();
      c.header('Cache-Control', 'private, no-store');
      return c.json({
        secrets: (result.results ?? []).map((r) => ({ name: r.name, updatedAt: r.updated_at, lastUsedAt: r.last_used_at })),
      });
    }),
  );

  secretsRoutes.put(
    '/apps/:appId/user-secrets/:name',
    wrap(async (c) => {
      const appId = c.req.param('appId')!;
      const name = c.req.param('name')!;
      const user = await caller(c, appId);
      if (!SECRET_NAME_RE.test(name)) {
        throw new HttpError('name must be uppercase + underscores (e.g. OPENAI_KEY)', 400);
      }
      await requireWriteRate(c, appId, user.id);
      const declared = await c.env.DB.prepare('SELECT 1 FROM app_user_secret_decls WHERE app_id = ? AND name = ?')
        .bind(appId, name)
        .first();
      if (!declared) throw new HttpError(`user secret '${name}' is not declared in this app's mcp.json user_secrets`, 400);
      const kek = requireKek(c);

      const body = await c.req.json<{ value?: unknown }>().catch(() => ({}) as { value?: unknown });
      const value = body.value;
      if (typeof value !== 'string' || value.length === 0) {
        throw new HttpError('value must be a non-empty string', 400);
      }
      if (value.length > MAX_SECRET_VALUE_CHARS) {
        throw new HttpError(`value too long (max ${MAX_SECRET_VALUE_CHARS} chars)`, 400);
      }
      // It is injected into a header or query string: no CR/LF, NUL or other control characters.
      if (/[\u0000-\u001f\u007f]/.test(value)) {
        throw new HttpError('value must not contain control characters', 400);
      }

      const sealed = await sealUserSecret(value, kek, appId, user.id, name);
      const now = Date.now();
      await c.env.DB.prepare(
        `INSERT INTO app_user_secrets (app_id, user_id, name, key_ciphertext, dek_wrapped, iv, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(app_id, user_id, name) DO UPDATE SET
           key_ciphertext = excluded.key_ciphertext,
           dek_wrapped    = excluded.dek_wrapped,
           iv             = excluded.iv,
           updated_at     = excluded.updated_at`,
      )
        .bind(appId, user.id, name, sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, now)
        .run();
      return c.body(null, 204);
    }),
  );

  // No declaration check: a user can always remove their own secret, even one the app no longer declares.
  secretsRoutes.delete(
    '/apps/:appId/user-secrets/:name',
    wrap(async (c) => {
      const appId = c.req.param('appId')!;
      const user = await caller(c, appId);
      await requireWriteRate(c, appId, user.id);
      const result = await c.env.DB.prepare('DELETE FROM app_user_secrets WHERE app_id = ? AND user_id = ? AND name = ?')
        .bind(appId, user.id, c.req.param('name')!)
        .run();
      if (result.meta.changes === 0) throw new HttpError('user secret not found', 404);
      return c.body(null, 204);
    }),
  );
}
