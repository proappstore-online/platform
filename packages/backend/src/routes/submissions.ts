import { Hono } from 'hono';
import { selectTemplate, TEMPLATE_REV_RE } from '@proappstore/build-core';
import type { Env, SubmissionRow } from '../types.js';
import { requireUser } from '../lib/auth.js';
import { wrap, privateNoStore } from '../lib/route-wrap.js';
import type { CreateBody } from './submissions-types.js';
import { isAdmin, rowToSubmission, submissionRepoUrl, APP_ID_RE } from './submissions-helpers.js';
import { registerReviewRoutes } from './submissions-review.js';

/**
 * Submission flow — pro side.
 *
 *   1. Dev POSTs a submission with the desired app id + metadata.
 *   2. Submission lands in `submissions` with status='pending'.
 *   3. Admin lists pending submissions and either:
 *        a. POST /v1/submissions/:id/approve — runs the PAS admin worker's
 *           publish provisioner (GitHub repo, R2 host route, storefront
 *           registry — Path B) and the PAS-local steps from /v1/provision. Submission
 *           moves to status='approved' before the call (one approval can claim it,
 *           #383) and 'published' after; a failed provision returns it to 'pending'.
 *        b. POST /v1/submissions/:id/reject — with required reason.
 *   4. Dev may DELETE their own submission while it's still pending.
 *
 * Admin authority is membership in env.ADMIN_GITHUB_IDS (comma-separated
 * `gh:<id>` strings). Non-admins see only their own submissions.
 */
export const submissionRoutes = new Hono<{ Bindings: Env }>();
// #378: owner-only reads are never cached.
submissionRoutes.use('/me/is-admin', privateNoStore);
submissionRoutes.use('/submissions', privateNoStore);
submissionRoutes.use('/submissions/*', privateNoStore);

/**
 * Lightweight admin probe used by the Console to decide whether to render
 * the Admin tab. Same membership check as the approve/reject gates — kept
 * here next to `isAdmin` so the source of truth is one function.
 */
submissionRoutes.get('/me/is-admin', wrap(async (c) => {
  const user = await requireUser(c);
  return c.json({ admin: isAdmin(user, c.env) });
}));

submissionRoutes.post('/submissions', wrap(async (c) => {
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

  // #366: provenance. The repository is pinned to the one the platform provisions
  // for this app id; a submitter-chosen URL never reaches a privileged fetch.
  let repoUrl: string | null = null;
  if (body.repoUrl != null && body.repoUrl !== '') {
    const expected = submissionRepoUrl(appId);
    if (typeof body.repoUrl !== 'string' || body.repoUrl.trim().replace(/\/$/, '') !== expected) {
      return c.text(`repoUrl must be ${expected}`, 400);
    }
    repoUrl = expected;
  }
  // The template is checked against the approved catalogue (#178) with no
  // override: only a platform admin may provision outside it, never a submitter.
  let templateId: string | null = null;
  let templateRev: string | null = null;
  if (body.template != null) {
    if (typeof body.template !== 'string' || !body.template.trim()) return c.text('template must be a catalogue id', 400);
    const selection = selectTemplate(body.template);
    if (!selection.ok || !selection.template) return c.text(`template: ${selection.reason}`, 400);
    templateId = selection.template.id;
  }
  if (body.templateRev != null) {
    if (typeof body.templateRev !== 'string' || !TEMPLATE_REV_RE.test(body.templateRev)) {
      return c.text('templateRev must be a git object id (7–40 hex chars)', 400);
    }
    if (!templateId) return c.text('templateRev requires template', 400);
    templateRev = body.templateRev;
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

  // The SELECT above is the friendly fast path; the partial unique index from
  // migration 0090 is the guarantee (#363). A concurrent submission that got past
  // it loses here, writes nothing, and gets the same 409.
  try {
    await c.env.DB.prepare(
      `INSERT INTO submissions (
         id, app_id, creator_id, status, name, category, description,
         icon, icon_bg, pro_features, suggested_monthly_price_cents,
         repo_url, created_at, template_id, template_rev
       ) VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
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
        repoUrl,
        now,
        templateId,
        templateRev,
      )
      .run();
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : '')) {
      return c.text('A pending submission already exists for that appId', 409);
    }
    throw err;
  }

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
    repo_url: repoUrl,
    template_id: templateId,
    template_rev: templateRev,
    reviewer_id: null,
    rejection_reason: null,
    created_at: now,
    reviewed_at: null,
  };
  return c.json({ submission: row }, 201);
}));

submissionRoutes.get('/submissions', wrap(async (c) => {
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
}));

submissionRoutes.get('/submissions/:id', wrap(async (c) => {
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
}));

// Admin review handlers (approve + reject) live in a sibling module.
registerReviewRoutes(submissionRoutes);

submissionRoutes.delete('/submissions/:id', wrap(async (c) => {
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

  // #383: never delete a submission an approval has claimed in the meantime.
  const deleted = await c.env.DB.prepare(`DELETE FROM submissions WHERE id = ?1 AND creator_id = ?2 AND status = 'pending'`)
    .bind(id, user.id)
    .run();
  if (deleted.meta.changes === 0) {
    const now = await c.env.DB.prepare(`SELECT status FROM submissions WHERE id = ?1`).bind(id).first<{ status: string }>();
    return now ? c.text(`Submission is ${now.status}, not pending`, 422) : c.text('Not found', 404);
  }
  return c.json({ ok: true });
}));
