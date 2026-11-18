import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser } from '../lib/auth.js';
import { wrap } from '../lib/route-wrap.js';
import { appEmailAccess } from '../lib/app-email-access.js';
import { sendEmail, isLikelyEmail } from '../lib/email.js';

export const emailRoutes = new Hono<{ Bindings: Env }>();

const MAX_SUBJECT = 200;
const MAX_BODY = 50 * 1024; // 50KB
const DAILY_LIMIT = 100;

/**
 * POST /v1/email/send — send a transactional email on behalf of an app.
 * Caller must own the app or have 'editor' role. Rate-limited to 100/day per app.
 */
emailRoutes.post('/email/send', wrap(async (c) => {
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

  const access = await appEmailAccess(c.env, user, appId);
  if (access === 'not_found') return c.text('app not found', 404);
  if (access === 'forbidden') return c.text('not authorized to send email for this app', 403);

  // Rate limit: 100 emails per day per app. The slot is reserved BEFORE sending,
  // and (#376) the cap is checked inside the same INSERT: a separate COUNT then
  // INSERT let N concurrent sends at limit - 1 all pass the count.
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const insert = await c.env.DB.prepare(
    `INSERT INTO email_usage (app_id, user_id, sent_at)
     SELECT ?1, ?2, ?3
      WHERE (SELECT COUNT(*) FROM email_usage WHERE app_id = ?1 AND sent_at > ?4) < ?5`,
  ).bind(appId, user.id, now, dayAgo, DAILY_LIMIT).run();
  if (!insert.meta.changes) {
    return c.text(`daily email limit reached (${DAILY_LIMIT}/day)`, 429);
  }
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
}));
