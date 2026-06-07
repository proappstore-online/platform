import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';

/**
 * Apps owned by the signed-in dev. The `apps` table is the source of truth
 * for "what got provisioned" (every successful provision INSERTs a row via
 * `record_app`). Console reads this to show a dev's dashboard.
 *
 * Why not just have Console read KV? `pas create` and the provisioner write
 * to the `apps` table, never to KV, so KV is always empty for everyone —
 * which is why the Dashboard showed nothing.
 *
 * Each row is enriched with the latest matching submission's metadata
 * (name, category, description, etc.) when one exists. Apps provisioned
 * before the submissions flow existed (meetup, loopride, dating, etc.)
 * fall back to a Title Case of the id for `name`.
 */

interface AppRow {
  id: string;
  creator_id: string;
  d1_database_id: string;
  created_at: number;
}

interface SubmissionMetaRow {
  app_id: string;
  name: string;
  category: string;
  description: string;
  icon: string | null;
  icon_bg: string | null;
  pro_features: string | null;
  status: string;
  suggested_monthly_price_cents: number | null;
  created_at: number;
}

interface AppDto {
  id: string;
  creator_id: string;
  created_at: number;
  d1_database_id: string;
  name: string;
  category: string | null;
  description: string | null;
  icon: string | null;
  icon_bg: string | null;
  pro_features: string[] | null;
  /** True iff a submissions row exists for this app (under the same creator). */
  has_submission: boolean;
  /** Status of the most recent submission, if any. */
  submission_status: string | null;
}

function toTitleCase(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function isAdmin(userId: string, env: Env): boolean {
  if (!env.ADMIN_GITHUB_IDS) return false;
  return env.ADMIN_GITHUB_IDS.split(',')
    .map((s) => s.trim())
    .includes(userId);
}

export const appsRoutes = new Hono<{ Bindings: Env }>();

appsRoutes.get('/apps', async (c) => {
  try {
    const user = await requireUser(c);
    const wantAll = c.req.query('all') === 'true' && isAdmin(user.id, c.env);
    const creatorFilter = wantAll ? null : user.id;

    // Pull apps: owned by this user OR where they're a team member (or all if admin).
    const appsQuery = creatorFilter
      ? c.env.DB.prepare(
          `SELECT DISTINCT a.* FROM apps a
           LEFT JOIN team_members tm ON tm.app_id = a.id AND tm.user_id = ?1
           WHERE a.creator_id = ?1 OR tm.user_id IS NOT NULL
           ORDER BY a.created_at DESC`,
        ).bind(creatorFilter)
      : c.env.DB.prepare('SELECT * FROM apps ORDER BY created_at DESC');
    const appsResult = await appsQuery.all<AppRow>();
    const apps = appsResult.results ?? [];

    if (apps.length === 0) {
      return c.json({ apps: [] satisfies AppDto[] });
    }

    // Pull all submissions for the same creator(s) and bucket by app_id, latest-first.
    // (For admins listing all apps, we pull all submissions; for devs, only theirs.)
    const subsQuery = creatorFilter
      ? c.env.DB.prepare(
          'SELECT app_id, name, category, description, icon, icon_bg, pro_features, status, suggested_monthly_price_cents, created_at FROM submissions WHERE creator_id = ? ORDER BY created_at DESC',
        ).bind(creatorFilter)
      : c.env.DB.prepare(
          'SELECT app_id, name, category, description, icon, icon_bg, pro_features, status, suggested_monthly_price_cents, created_at FROM submissions ORDER BY created_at DESC',
        );
    const subsResult = await subsQuery.all<SubmissionMetaRow>();
    const latestByAppId = new Map<string, SubmissionMetaRow>();
    for (const s of subsResult.results ?? []) {
      // Iterating DESC order; first occurrence is most-recent.
      if (!latestByAppId.has(s.app_id)) latestByAppId.set(s.app_id, s);
    }

    const dtos: AppDto[] = apps.map((a) => {
      const sub = latestByAppId.get(a.id);
      let proFeatures: string[] | null = null;
      if (sub?.pro_features) {
        try {
          const parsed = JSON.parse(sub.pro_features);
          if (Array.isArray(parsed)) proFeatures = parsed;
        } catch {
          // bad JSON in column — skip rather than 500ing the whole list
        }
      }
      return {
        id: a.id,
        creator_id: a.creator_id,
        created_at: a.created_at,
        d1_database_id: a.d1_database_id,
        name: sub?.name ?? toTitleCase(a.id),
        category: sub?.category ?? null,
        description: sub?.description ?? null,
        icon: sub?.icon ?? null,
        icon_bg: sub?.icon_bg ?? null,
        pro_features: proFeatures,
        has_submission: !!sub,
        submission_status: sub?.status ?? null,
      };
    });

    return c.json({ apps: dtos });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Remove an app from the owner's dashboard listing. This does NOT
 * deprovision Cloudflare Pages, D1, the GitHub repo, DNS, or the storefront
 * registry — those keep working. It only deletes the row in the `apps`
 * table that Console reads for "my apps." If the dev later wants the app
 * back on their dashboard, re-running provision (idempotent) re-inserts it.
 *
 * Owner-only. Admin can delete any.
 */
appsRoutes.delete('/apps/:id', async (c) => {
  try {
    const user = await requireUser(c);
    const id = c.req.param('id');
    if (!id) return c.text('id required', 400);

    const existing = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?')
      .bind(id)
      .first<{ creator_id: string }>();
    if (!existing) return c.text('Not found', 404);

    const owns = existing.creator_id === user.id;
    if (!owns && !isAdmin(user.id, c.env)) return c.text('Forbidden', 403);

    await c.env.DB.prepare('DELETE FROM apps WHERE id = ?').bind(id).run();
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
