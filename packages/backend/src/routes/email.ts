import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import { sendEmail, isLikelyEmail } from '../lib/email.js';

export const emailRoutes = new Hono<{ Bindings: Env }>();

const MAX_SUBJECT = 200;
const MAX_BODY = 50 * 1024; // 50KB
const DAILY_LIMIT = 100;

/**
 * POST /v1/email/send — send a transactional email on behalf of an app.
 * Caller must own the app or have 'editor' role. Rate-limited to 100/day per app.
 */
emailRoutes.post('/email/send', async (c) => {
  try {
    const apiKey = c.env.RESEND_API_KEY;
    if (!apiKey) return c.text('email not configured', 503);

    const user = await requireUser(c);
    const { appId, to, subject, body, replyTo } = await c.req.json<{
      appId: string;
      to: string;
      subject: string;
      body: string;
      replyTo?: string;
    }>();

    if (!appId || !to || !subject || !body) {
      return c.text('missing required fields: appId, to, subject, body', 400);
    }

    // Validate email
    if (!isLikelyEmail(to)) return c.text('invalid email address', 400);
    if (subject.length > MAX_SUBJECT) return c.text(`subject too long (max ${MAX_SUBJECT} chars)`, 400);
    if (body.length > MAX_BODY) return c.text(`body too large (max ${MAX_BODY / 1024}KB)`, 400);
    if (replyTo && !isLikelyEmail(replyTo)) return c.text('invalid replyTo address', 400);

    // Verify caller owns app or has editor role
    const app = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?1').bind(appId).first<{ creator_id: string }>();
    if (!app) return c.text('app not found', 404);
    const isOwner = app.creator_id === user.id;
    const isAdmin = user.roles.includes('admin');
    const isEditor = user.appRoles[appId]?.includes('editor');
    if (!isOwner && !isAdmin && !isEditor) {
      return c.text('not authorized to send email for this app', 403);
    }

    // Rate limit: 100 emails per day per app.
    // Insert the usage row BEFORE sending to prevent concurrent requests
    // from bypassing the limit (check-then-act race condition).
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 86400;
    const usage = await c.env.DB.prepare(
      'SELECT COUNT(*) as n FROM email_usage WHERE app_id = ?1 AND sent_at > ?2',
    ).bind(appId, dayAgo).first<{ n: number }>();
    if (usage && usage.n >= DAILY_LIMIT) {
      return c.text(`daily email limit reached (${DAILY_LIMIT}/day)`, 429);
    }

    // Reserve the slot before sending so concurrent requests can't bypass the limit
    const insert = await c.env.DB.prepare(
      'INSERT INTO email_usage (app_id, user_id, sent_at) VALUES (?1, ?2, ?3)',
    ).bind(appId, user.id, now).run();
    const rowId = insert.meta.last_row_id;

    const from = c.env.EMAIL_FROM ?? 'ProAppStore <noreply@proappstore.online>';

    try {
      await sendEmail(
        { apiKey, from },
        { to, subject, html: body, text: body, ...(replyTo && { replyTo }) },
      );
    } catch (err) {
      // Rollback the usage row if send fails
      await c.env.DB.prepare('DELETE FROM email_usage WHERE id = ?1').bind(rowId).run();
      throw err;
    }

    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
