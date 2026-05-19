import { Hono } from 'hono';
import type { Env, SubmissionRow } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import { callAdminProvision } from '../lib/provision-client.js';

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

interface FasUser {
  id: string;
  login: string;
  avatarUrl: string | null;
}

interface CreateBody {
  appId?: string;
  name?: string;
  category?: string;
  description?: string;
  icon?: string;
  iconBg?: string;
  proFeatures?: string[];
  suggestedMonthlyPriceCents?: number;
  repoUrl?: string;
}

interface ApproveBody {
  suggestedMonthlyPriceCents?: number;
}

interface RejectBody {
  reason?: string;
}

function isAdmin(user: FasUser, env: Env): boolean {
  const raw = env.ADMIN_GITHUB_IDS;
  if (!raw) return false;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.includes(user.id);
}

/** Hydrate a raw D1 row into the typed SubmissionRow shape. */
function rowToSubmission(row: Record<string, unknown>): SubmissionRow {
  return {
    id: row.id as string,
    app_id: row.app_id as string,
    creator_id: row.creator_id as string,
    status: row.status as SubmissionRow['status'],
    name: row.name as string,
    category: row.category as string,
    description: row.description as string,
    icon: (row.icon as string | null) ?? null,
    icon_bg: (row.icon_bg as string | null) ?? null,
    pro_features: (row.pro_features as string | null) ?? null,
    suggested_monthly_price_cents:
      row.suggested_monthly_price_cents == null
        ? null
        : Number(row.suggested_monthly_price_cents),
    repo_url: (row.repo_url as string | null) ?? null,
    reviewer_id: (row.reviewer_id as string | null) ?? null,
    rejection_reason: (row.rejection_reason as string | null) ?? null,
    created_at: Number(row.created_at),
    reviewed_at: row.reviewed_at == null ? null : Number(row.reviewed_at),
  };
}

const APP_ID_RE = /^[a-z][a-z0-9-]*$/;

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
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
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
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
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
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});

submissionRoutes.post('/submissions/:id/approve', async (c) => {
  try {
    const user = await requireUser(c);
    if (!isAdmin(user, c.env)) return c.text('Forbidden', 403);

    const id = c.req.param('id');
    const body = await c.req.json<ApproveBody>().catch(() => ({} as ApproveBody));

    const row = await c.env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) return c.text('Not found', 404);
    const submission = rowToSubmission(row);
    if (submission.status !== 'pending') {
      return c.text(`Submission is ${submission.status}, not pending`, 422);
    }

    const overridePrice =
      body.suggestedMonthlyPriceCents != null &&
      typeof body.suggestedMonthlyPriceCents === 'number' &&
      Number.isFinite(body.suggestedMonthlyPriceCents) &&
      body.suggestedMonthlyPriceCents >= 0
        ? body.suggestedMonthlyPriceCents
        : null;

    const now = Date.now();
    if (overridePrice != null) {
      await c.env.DB.prepare(
        `UPDATE submissions
           SET status = 'approved',
               reviewer_id = ?1,
               reviewed_at = ?2,
               suggested_monthly_price_cents = ?3
         WHERE id = ?4`,
      )
        .bind(user.id, now, overridePrice, id)
        .run();
    } else {
      await c.env.DB.prepare(
        `UPDATE submissions
           SET status = 'approved',
               reviewer_id = ?1,
               reviewed_at = ?2
         WHERE id = ?3`,
      )
        .bind(user.id, now, id)
        .run();
    }

    // Call existing provisioning logic via the shared helper.
    const proFeatures = submission.pro_features
      ? (() => {
          try {
            const parsed = JSON.parse(submission.pro_features as string);
            return Array.isArray(parsed) ? (parsed as string[]) : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined;

    let provisionResult: unknown = null;
    if (c.env.ADMIN) {
      // Build options without undefined fields — exactOptionalPropertyTypes
      // is strict, so we omit instead of passing `undefined`.
      const opts: import('../lib/provision-client.js').ProvisionBody = {
        appId: submission.app_id,
        name: submission.name,
        category: submission.category,
        description: submission.description,
      };
      if (submission.icon) opts.icon = submission.icon;
      if (submission.icon_bg) opts.iconBg = submission.icon_bg;
      if (proFeatures) opts.proFeatures = proFeatures;
      provisionResult = await callAdminProvision(c.env.ADMIN, opts);
      const provisionSucceeded =
        provisionResult &&
        typeof provisionResult === 'object' &&
        !('error' in (provisionResult as Record<string, unknown>)) &&
        (provisionResult as { success?: boolean }).success === true;
      if (provisionSucceeded) {
        await c.env.DB.prepare(
          `UPDATE submissions SET status = 'published' WHERE id = ?1`,
        )
          .bind(id)
          .run();
      }
    } else {
      provisionResult = { error: 'ADMIN service binding not configured' };
    }

    const updated = await c.env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    return c.json({
      submission: updated ? rowToSubmission(updated) : submission,
      provisionResult,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});

submissionRoutes.post('/submissions/:id/reject', async (c) => {
  try {
    const user = await requireUser(c);
    if (!isAdmin(user, c.env)) return c.text('Forbidden', 403);

    const id = c.req.param('id');
    const body = await c.req.json<RejectBody>().catch(() => ({} as RejectBody));
    const reason = (body.reason ?? '').trim();
    if (!reason || reason.length < 1 || reason.length > 500) {
      return c.text('reason is required (1–500 chars)', 400);
    }

    const row = await c.env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) return c.text('Not found', 404);
    const submission = rowToSubmission(row);
    if (submission.status !== 'pending') {
      return c.text(`Submission is ${submission.status}, not pending`, 422);
    }

    const now = Date.now();
    await c.env.DB.prepare(
      `UPDATE submissions
         SET status = 'rejected', reviewer_id = ?1, reviewed_at = ?2, rejection_reason = ?3
       WHERE id = ?4`,
    )
      .bind(user.id, now, reason, id)
      .run();

    const updated = await c.env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    return c.json({ submission: updated ? rowToSubmission(updated) : submission });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});

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
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});
