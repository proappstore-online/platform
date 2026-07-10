import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import type { ApproveBody, RejectBody } from './submissions-types.js';
import { isAdmin, rowToSubmission } from './submissions-helpers.js';

/**
 * Admin review handlers — approve (runs the provisioner) and reject. Attached
 * to the shared `submissionRoutes` Hono instance so all routes register under
 * one router while keeping this cohesive group in its own module.
 */
export function registerReviewRoutes(
  submissionRoutes: Hono<{ Bindings: Env }>,
): void {
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

      // Provision the app using PAS's own provision endpoint (self-contained).
      const token = c.req.header('Authorization')?.slice(7) || '';
      const provisionBody: Record<string, unknown> = {
        appId: submission.app_id,
        name: submission.name,
        category: submission.category,
        description: submission.description,
        skipCompliance: true,
      };
      if (submission.icon) provisionBody.icon = submission.icon;
      if (submission.icon_bg) provisionBody.iconBg = submission.icon_bg;
      if (proFeatures) provisionBody.proFeatures = proFeatures;

      let provisionResult: unknown = null;
      try {
        const provRes = await c.env.SELF.fetch(`https://api.proappstore.online/v1/provision`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(provisionBody),
        });
        provisionResult = await provRes.json();
        const provisionSucceeded =
          provisionResult &&
          typeof provisionResult === 'object' &&
          (provisionResult as { success?: boolean }).success === true;
        if (provisionSucceeded) {
          await c.env.DB.prepare(
            `UPDATE submissions SET status = 'published' WHERE id = ?1`,
          )
            .bind(id)
            .run();
        }
      } catch (e) {
        provisionResult = { error: String(e) };
      }

      const updated = await c.env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
        .bind(id)
        .first<Record<string, unknown>>();
      return c.json({
        submission: updated ? rowToSubmission(updated) : submission,
        provisionResult,
      });
    } catch (err) {
      if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
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
      if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
      throw err;
    }
  });
}
