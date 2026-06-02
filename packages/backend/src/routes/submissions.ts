import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, SubmissionRow } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import type { CreateBody } from './submissions-types.js';
import { isAdmin, rowToSubmission, APP_ID_RE } from './submissions-helpers.js';
import { registerReviewRoutes } from './submissions-review.js';

/**
 * Submission flow — pro side.
 *
 *   1. Dev POSTs a submission with the desired app id + metadata.
 *   2. Submission lands in `submissions` with status='pending'.
 *   3. Admin lists pending submissions and either:
 *        a. POST /v1/submissions/:id/approve — runs the existing FAS-admin
 *           provisioner (GitHub repo, CF Pages, DNS, custom domain, storefront
 *           registry) and the PAS-local steps from /v1/provision. Submission
 *           moves to status='approved' before the call and 'published' after.
 *        b. POST /v1/submissions/:id/reject — with required reason.
 *   4. Dev may DELETE their own submission while it's still pending.
 *
 * Admin authority is membership in env.ADMIN_GITHUB_IDS (comma-separated
 * `gh:<id>` strings). Non-admins see only their own submissions.
 */
export const submissionRoutes = new Hono<{ Bindings: Env }>();

/**
 * Lightweight admin probe used by the Console to decide whether to render
 * the Admin tab. Same membership check as the approve/reject gates — kept
 * here next to `isAdmin` so the source of truth is one function.
 */
submissionRoutes.get('/me/is-admin', async (c) => {
  try {
    const user = await requireUser(c);
    return c.json({ admin: isAdmin(user, c.env) });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

submissionRoutes.post('/submissions', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<CreateBody>().catch(() => ({} as CreateBody));

    const appId = (body.appId ?? '').trim();
    const name = (body.name ?? '').trim();
    const category = (body.category ?? '').trim();
    const description = (body.description ?? '').trim();

    if (!appId || !APP_ID_RE.test(appId) || appId.length > 58) {
      return c.text('Invalid appId', 400);
    }
    if (!name) return c.text('Missing name', 400);
    if (!category) return c.text('Missing category', 400);
    if (!description) return c.text('Missing description', 400);

    if (body.proFeatures != null && !Array.isArray(body.proFeatures)) {
      return c.text('proFeatures must be a string array', 400);
    }
    if (
      body.suggestedMonthlyPriceCents != null &&
      (typeof body.suggestedMonthlyPriceCents !== 'number' ||
        !Number.isFinite(body.suggestedMonthlyPriceCents) ||
        body.suggestedMonthlyPriceCents < 0)
    ) {
      return c.text('suggestedMonthlyPriceCents must be a non-negative number', 400);
    }

    // 409 if an app with this id already exists or there's an open submission.
    const existingApp = await c.env.DB.prepare(
      `SELECT id FROM apps WHERE id = ?1`,
    )
      .bind(appId)
      .first<{ id: string }>();
    if (existingApp) return c.text('An app with that id already exists', 409);

    const existingSubmission = await c.env.DB.prepare(
      `SELECT id FROM submissions WHERE app_id = ?1 AND status = 'pending'`,
    )
      .bind(appId)
      .first<{ id: string }>();
    if (existingSubmission) {
      return c.text('A pending submission already exists for that appId', 409);
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const proFeaturesJson =
      body.proFeatures && body.proFeatures.length > 0
        ? JSON.stringify(body.proFeatures)
        : null;

    await c.env.DB.prepare(
      `INSERT INTO submissions (
         id, app_id, creator_id, status, name, category, description,
         icon, icon_bg, pro_features, suggested_monthly_price_cents,
         repo_url, created_at
       ) VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
      .bind(
        id,
        appId,
        user.id,
        name,
        category,
        description,
        body.icon ?? null,
        body.iconBg ?? null,
        proFeaturesJson,
        body.suggestedMonthlyPriceCents ?? null,
        body.repoUrl ?? null,
        now,
      )
      .run();

    const row: SubmissionRow = {
      id,
      app_id: appId,
      creator_id: user.id,
      status: 'pending',
      name,
      category,
      description,
      icon: body.icon ?? null,
      icon_bg: body.iconBg ?? null,
      pro_features: proFeaturesJson,
      suggested_monthly_price_cents: body.suggestedMonthlyPriceCents ?? null,
      repo_url: body.repoUrl ?? null,
      reviewer_id: null,
      rejection_reason: null,
      created_at: now,
      reviewed_at: null,
    };
    return c.json({ submission: row }, 201);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

submissionRoutes.get('/submissions', async (c) => {
  try {
    const user = await requireUser(c);
    const admin = isAdmin(user, c.env);
    const statusFilter = c.req.query('status');
    const allowedStatuses = ['pending', 'approved', 'rejected', 'published'];

    let sql = 'SELECT * FROM submissions';
    const binds: (string | number)[] = [];
    const where: string[] = [];

    if (!admin) {
      where.push('creator_id = ?');
      binds.push(user.id);
    }
    if (statusFilter && allowedStatuses.includes(statusFilter)) {
      where.push(`status = ?`);
      binds.push(statusFilter);
    }
    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC';

    const { results } = await c.env.DB.prepare(sql)
      .bind(...binds)
      .all<Record<string, unknown>>();
    const submissions = (results ?? []).map(rowToSubmission);
    return c.json({ submissions });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

submissionRoutes.get('/submissions/:id', async (c) => {
  try {
    const user = await requireUser(c);
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) return c.text('Not found', 404);
    const submission = rowToSubmission(row);
    if (submission.creator_id !== user.id && !isAdmin(user, c.env)) {
      return c.text('Forbidden', 403);
    }
    return c.json({ submission });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// Admin review handlers (approve + reject) live in a sibling module.
registerReviewRoutes(submissionRoutes);

submissionRoutes.delete('/submissions/:id', async (c) => {
  try {
    const user = await requireUser(c);
    const id = c.req.param('id');

    const row = await c.env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) return c.text('Not found', 404);
    const submission = rowToSubmission(row);
    if (submission.creator_id !== user.id) return c.text('Forbidden', 403);
    if (submission.status !== 'pending') {
      return c.text(`Submission is ${submission.status}, not pending`, 422);
    }

    await c.env.DB.prepare(`DELETE FROM submissions WHERE id = ?1`).bind(id).run();
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
