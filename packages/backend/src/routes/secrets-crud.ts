/**
 * Secrets CRUD routes. Extracted verbatim from secrets.ts.
 */
import type { Hono } from 'hono';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import { sealSecret } from '../lib/encryption.js';
import type { Env } from '../types.js';
import { MAX_SECRETS_PER_APP, requireKek, SECRET_NAME_RE, wrap } from './secrets-shared.js';

interface SecretListRow {
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export function registerSecretsCrudRoutes(secretsRoutes: Hono<{ Bindings: Env }>) {
  secretsRoutes.get(
    '/apps/:appId/secrets',
    wrap(async (c) => {
      await requireAppOwner(c, c.req.param('appId')!);
      const result = await c.env.DB.prepare(
        `SELECT name, created_at, last_used_at FROM app_secrets
         WHERE app_id = ? ORDER BY name`,
      )
        .bind(c.req.param('appId')!)
        .all<SecretListRow>();
      return c.json({
        secrets: (result.results ?? []).map((r) => ({
          name: r.name,
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
        })),
      });
    }),
  );

  secretsRoutes.put(
    '/apps/:appId/secrets/:name',
    wrap(async (c) => {
      const appId = c.req.param('appId')!;
      const name = c.req.param('name')!;
      if (!SECRET_NAME_RE.test(name)) {
        throw new HttpError('name must be uppercase + underscores (e.g. OPENWEATHER_KEY)', 400);
      }
      await requireAppOwner(c, appId);
      const kek = requireKek(c);

      const body = await c.req.json<{ value?: unknown }>().catch(() => ({}) as { value?: unknown });
      const value = body.value;
      if (typeof value !== 'string' || value.length === 0) {
        throw new HttpError('value must be a non-empty string', 400);
      }
      if (value.length > 4096) {
        throw new HttpError('value too long (max 4096 chars)', 400);
      }

      // Cap secrets per app — but allow updating an existing name without
      // bumping the count. SQLite has no upsert-with-count, so check first.
      const exists = await c.env.DB.prepare('SELECT 1 FROM app_secrets WHERE app_id = ? AND name = ?')
        .bind(appId, name)
        .first();
      if (!exists) {
        const countRow = await c.env.DB.prepare(
          'SELECT COUNT(*) AS n FROM app_secrets WHERE app_id = ?',
        )
          .bind(appId)
          .first<{ n: number }>();
        if ((countRow?.n ?? 0) >= MAX_SECRETS_PER_APP) {
          throw new HttpError(
            `app has reached the free-tier limit of ${MAX_SECRETS_PER_APP} secrets`,
            409,
          );
        }
      }

      const sealed = await sealSecret(value, kek);
      await c.env.DB.prepare(
        `INSERT INTO app_secrets (app_id, name, key_ciphertext, dek_wrapped, iv, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(app_id, name) DO UPDATE SET
           key_ciphertext = excluded.key_ciphertext,
           dek_wrapped    = excluded.dek_wrapped,
           iv             = excluded.iv`,
      )
        .bind(appId, name, sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, Date.now())
        .run();

      return c.body(null, 204);
    }),
  );

  secretsRoutes.delete(
    '/apps/:appId/secrets/:name',
    wrap(async (c) => {
      const appId = c.req.param('appId')!;
      const name = c.req.param('name')!;
      await requireAppOwner(c, appId);
      const result = await c.env.DB.prepare('DELETE FROM app_secrets WHERE app_id = ? AND name = ?')
        .bind(appId, name)
        .run();
      if (result.meta.changes === 0) throw new HttpError('secret not found', 404);
      return c.body(null, 204);
    }),
  );
}
