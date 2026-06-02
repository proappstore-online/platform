/**
 * Allowlist CRUD routes. Extracted verbatim from secrets.ts.
 */
import type { Hono } from 'hono';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import { validateRule } from '../lib/proxy-allowlist.js';
import type { Env } from '../types.js';
import type { AllowlistRow } from './secrets-allowlist-row.js';
import { MAX_ALLOWLIST_PER_APP, wrap } from './secrets-shared.js';

interface PutAllowlistBody {
  pattern?: unknown;
  injectKind?: unknown;
  injectName?: unknown;
  secretName?: unknown;
  secretName2?: unknown;
  tokenUrl?: unknown;
  methods?: unknown;
}

export function registerAllowlistCrudRoutes(secretsRoutes: Hono<{ Bindings: Env }>) {
  secretsRoutes.get(
    '/apps/:appId/allowlist',
    wrap(async (c) => {
      await requireAppOwner(c, c.req.param('appId')!);
      const result = await c.env.DB.prepare(
        `SELECT pattern, inject_kind, inject_name, secret_name, secret_name_2, token_url, methods, created_at
         FROM app_proxy_allowlist WHERE app_id = ? ORDER BY pattern`,
      )
        .bind(c.req.param('appId')!)
        .all<AllowlistRow>();
      return c.json({
        rules: (result.results ?? []).map((r) => ({
          pattern: r.pattern,
          injectKind: r.inject_kind,
          injectName: r.inject_name,
          secretName: r.secret_name,
          ...(r.secret_name_2 ? { secretName2: r.secret_name_2 } : {}),
          ...(r.token_url ? { tokenUrl: r.token_url } : {}),
          methods: r.methods.split(',').filter(Boolean),
          createdAt: r.created_at,
        })),
      });
    }),
  );

  secretsRoutes.put(
    '/apps/:appId/allowlist',
    wrap(async (c) => {
      const appId = c.req.param('appId')!;
      await requireAppOwner(c, appId);
      const body = await c.req.json<PutAllowlistBody>().catch(() => ({}) as PutAllowlistBody);
      const rule = validateRule({
        pattern: String(body.pattern ?? ''),
        injectKind: String(body.injectKind ?? ''),
        injectName: String(body.injectName ?? ''),
        secretName: String(body.secretName ?? ''),
        secretName2: body.secretName2 ? String(body.secretName2) : '',
        tokenUrl: body.tokenUrl ? String(body.tokenUrl) : '',
        methods: Array.isArray(body.methods) ? (body.methods as string[]) : [],
      });

      // Secret(s) must exist before we let an allowlist rule reference them —
      // otherwise the proxy will silently 404 every call.
      const secretExists = await c.env.DB.prepare(
        'SELECT 1 FROM app_secrets WHERE app_id = ? AND name = ?',
      )
        .bind(appId, rule.secretName)
        .first();
      if (!secretExists) {
        throw new HttpError(`secret '${rule.secretName}' not found for this app`, 400);
      }
      if (rule.secretName2) {
        const secret2Exists = await c.env.DB.prepare(
          'SELECT 1 FROM app_secrets WHERE app_id = ? AND name = ?',
        )
          .bind(appId, rule.secretName2)
          .first();
        if (!secret2Exists) {
          throw new HttpError(`secret '${rule.secretName2}' not found for this app`, 400);
        }
      }

      // Free cap on rule count (only when adding a new pattern).
      const exists = await c.env.DB.prepare(
        'SELECT 1 FROM app_proxy_allowlist WHERE app_id = ? AND pattern = ?',
      )
        .bind(appId, rule.pattern)
        .first();
      if (!exists) {
        const countRow = await c.env.DB.prepare(
          'SELECT COUNT(*) AS n FROM app_proxy_allowlist WHERE app_id = ?',
        )
          .bind(appId)
          .first<{ n: number }>();
        if ((countRow?.n ?? 0) >= MAX_ALLOWLIST_PER_APP) {
          throw new HttpError(
            `app has reached the free-tier limit of ${MAX_ALLOWLIST_PER_APP} allowlist rules`,
            409,
          );
        }
      }

      await c.env.DB.prepare(
        `INSERT INTO app_proxy_allowlist
           (app_id, pattern, inject_kind, inject_name, secret_name, secret_name_2, token_url, methods, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(app_id, pattern) DO UPDATE SET
           inject_kind   = excluded.inject_kind,
           inject_name   = excluded.inject_name,
           secret_name   = excluded.secret_name,
           secret_name_2 = excluded.secret_name_2,
           token_url     = excluded.token_url,
           methods       = excluded.methods`,
      )
        .bind(
          appId,
          rule.pattern,
          rule.injectKind,
          rule.injectName,
          rule.secretName,
          rule.secretName2 || null,
          rule.tokenUrl || null,
          rule.methods.join(','),
          Date.now(),
        )
        .run();

      return c.body(null, 204);
    }),
  );

  secretsRoutes.delete(
    '/apps/:appId/allowlist',
    wrap(async (c) => {
      const appId = c.req.param('appId')!;
      await requireAppOwner(c, appId);
      const body = await c.req
        .json<{ pattern?: unknown }>()
        .catch(() => ({}) as { pattern?: unknown });
      const pattern = String(body.pattern ?? '');
      if (!pattern) throw new HttpError('pattern is required', 400);
      const result = await c.env.DB.prepare(
        'DELETE FROM app_proxy_allowlist WHERE app_id = ? AND pattern = ?',
      )
        .bind(appId, pattern)
        .run();
      if (result.meta.changes === 0) throw new HttpError('rule not found', 404);
      return c.body(null, 204);
    }),
  );
}
