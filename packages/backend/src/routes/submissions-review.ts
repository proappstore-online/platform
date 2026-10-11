import type { Context, Hono } from 'hono';
import { selectTemplate } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { requireUser } from '../lib/auth.js';
import { wrap } from '../lib/route-wrap.js';
import type { ApproveBody, RejectBody } from './submissions-types.js';
import { isAdmin, rowToSubmission } from './submissions-helpers.js';
import { provisionApp, type ProvisionBody } from './provision.js';

/**
 * A claimed approval older than this is presumed dead — its Worker stopped
 * mid-provision, so nothing will publish or release it — and may be approved
 * again (#383). Provisioning finishes well inside it.
 */
export const APPROVAL_LEASE_MS = 10 * 60_000;

/** The submission's current state as a refusal: 404 when it is gone, else 422 naming its status. */
async function notPending(c: Context<{ Bindings: Env }>, id: string): Promise<Response> {
  const row = await c.env.DB.prepare(`SELECT status FROM submissions WHERE id = ?1`).bind(id).first<{ status: string }>();
  return row ? c.text(`Submission is ${row.status}, not pending`, 422) : c.text('Not found', 404);
}

/**
 * Admin review handlers — approve (runs the provisioner) and reject. Attached
 * to the shared `submissionRoutes` Hono instance so all routes register under
 * one router while keeping this cohesive group in its own module.
 */
export function registerReviewRoutes(
  submissionRoutes: Hono<{ Bindings: Env }>,
): void {
  submissionRoutes.post('/submissions/:id/approve', wrap(async (c) => {
    const user = await requireUser(c);
    if (!isAdmin(user, c.env)) return c.text('Forbidden', 403);

    const id = c.req.param('id')!;
    const body = await c.req.json<ApproveBody>().catch(() => ({} as ApproveBody));

    const row = await c.env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) return c.text('Not found', 404);
    const submission = rowToSubmission(row);
    const now = Date.now();
    const staleClaim = submission.status === 'approved' && submission.reviewed_at != null && submission.reviewed_at < now - APPROVAL_LEASE_MS;
    if (submission.status !== 'pending' && !staleClaim) {
      return c.text(`Submission is ${submission.status}, not pending`, 422);
    }

    // #366: the provenance the submission carried, re-checked against today's
    // catalogue (a template may have been withdrawn since) before anything changes.
    // No admin override here: approving does not widen what was submitted.
    let templateId: string | null = null;
    if (submission.template_id) {
      const selection = selectTemplate(submission.template_id);
      if (!selection.ok || !selection.template) {
        return c.text(`Submission template can no longer be provisioned: ${selection.reason}`, 422);
      }
      templateId = selection.template.id;
    }

    const overridePrice =
      body.suggestedMonthlyPriceCents != null &&
      typeof body.suggestedMonthlyPriceCents === 'number' &&
      Number.isFinite(body.suggestedMonthlyPriceCents) &&
      body.suggestedMonthlyPriceCents >= 0
        ? body.suggestedMonthlyPriceCents
        : null;

    // #383: claim the submission. Only one approval can move it out of pending
    // (or take over a dead claim); a second approval, or one racing the creator's
    // delete, changes nothing here and provisions nothing.
    const claim = await c.env.DB.prepare(
      `UPDATE submissions
         SET status = 'approved',
             reviewer_id = ?1,
             reviewed_at = ?2,
             suggested_monthly_price_cents = COALESCE(?3, suggested_monthly_price_cents)
       WHERE id = ?4 AND (status = 'pending' OR (status = 'approved' AND reviewed_at < ?5))`,
    )
      .bind(user.id, now, overridePrice, id, now - APPROVAL_LEASE_MS)
      .run();
    if (claim.meta.changes === 0) return notPending(c, id);

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

    // #382: provision as the SUBMITTER, not the approving admin. The admin's role
    // only unlocks skipCompliance/templateUnknown; the app, its owner row and
    // its data plane belong to submission.creator_id. No repo is forwarded: with
    // compliance skipped, provisioning never reads one.
    const provisionBody: ProvisionBody = {
      appId: submission.app_id,
      name: submission.name,
      category: submission.category,
      description: submission.description,
      skipCompliance: true,
    };
    if (submission.icon) provisionBody.icon = submission.icon;
    if (submission.icon_bg) provisionBody.iconBg = submission.icon_bg;
    if (proFeatures) provisionBody.proFeatures = proFeatures;
    if (templateId) {
      provisionBody.template = templateId;
      if (submission.template_rev) provisionBody.templateRev = submission.template_rev;
    } else {
      // Legacy or provenance-less submission: say so, rather than let provisioning
      // default it to template-app.
      provisionBody.templateUnknown = true;
    }

    let provisionResult: unknown = null;
    let provisionSucceeded = false;
    try {
      const provRes = await provisionApp(c, provisionBody, user, submission.creator_id);
      // A refusal (403/429/503) answers in plain text; surface it rather than a JSON parse error.
      provisionResult = (provRes.headers.get('Content-Type') ?? '').includes('json')
        ? await provRes.json()
        : { error: await provRes.text(), status: provRes.status };
      provisionSucceeded =
        !!provisionResult &&
        typeof provisionResult === 'object' &&
        (provisionResult as { success?: boolean }).success === true;
    } catch (e) {
      provisionResult = { error: String(e) };
    }

    if (provisionSucceeded) {
      await c.env.DB.prepare(
        `UPDATE submissions SET status = 'published' WHERE id = ?1 AND status = 'approved'`,
      )
        .bind(id)
        .run();
    } else {
      // #383: release the claim so the submission can be approved (re-provisioning
      // is idempotent) or rejected again. If the creator opened a newer pending
      // submission for the same app meanwhile, the one-pending-per-app index
      // (migration 0090) refuses this; the row stays approved and the newer one stands.
      try {
        await c.env.DB.prepare(`UPDATE submissions SET status = 'pending' WHERE id = ?1 AND status = 'approved'`)
          .bind(id)
          .run();
      } catch (err) {
        if (!/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : '')) throw err;
      }
    }

    const updated = await c.env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    return c.json({
      submission: updated ? rowToSubmission(updated) : submission,
      provisionResult,
    }, provisionSucceeded ? 200 : 500);
  }));

  submissionRoutes.post('/submissions/:id/reject', wrap(async (c) => {
    const user = await requireUser(c);
    if (!isAdmin(user, c.env)) return c.text('Forbidden', 403);

    const id = c.req.param('id')!;
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
    // #383: only a pending submission can be rejected — never one an approval
    // has claimed or already published.
    const rejected = await c.env.DB.prepare(
      `UPDATE submissions
         SET status = 'rejected', reviewer_id = ?1, reviewed_at = ?2, rejection_reason = ?3
       WHERE id = ?4 AND status = 'pending'`,
    )
      .bind(user.id, now, reason, id)
      .run();
    if (rejected.meta.changes === 0) return notPending(c, id);

    const updated = await c.env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    return c.json({ submission: updated ? rowToSubmission(updated) : submission });
  }));
}
