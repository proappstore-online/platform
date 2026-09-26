import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import webpush from 'web-push';
import { internalTokenOk } from '@proappstore/build-core';
import type { Env, PushSubscriptionRow } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import { dispatchWebhook } from '../lib/webhook-dispatch.js';
import { isLikelyEmail, sendEmail } from '../lib/email.js';
import { isAppOriginUrl, renderNotifyEmail, signUnsubscribeToken, verifyUnsubscribeToken } from '../lib/notify-email.js';
import { moderateText } from '../lib/moderation.js';

export const notificationRoutes = new Hono<{ Bindings: Env }>();

/** Send one payload to a set of subscriptions; prune dead endpoints. Shared by
 *  the public + internal send paths. */
async function sendPushToSubs(env: Env, subs: PushSubscriptionRow[], payload: string): Promise<{ sent: number; failed: number }> {
  if (subs.length === 0) return { sent: 0, failed: 0 };
  webpush.setVapidDetails('mailto:push@proappstore.online', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  let sent = 0;
  let failed = 0;
  const dead: string[] = [];
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_secret } }, payload);
        sent++;
      } catch (err: any) {
        failed++;
        if (err?.statusCode === 410 || err?.statusCode === 404) dead.push(sub.endpoint);
      }
    }),
  );
  if (dead.length > 0) {
    const placeholders = dead.map((_, i) => `?${i + 1}`).join(',');
    await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint IN (${placeholders})`).bind(...dead).run();
  }
  return { sent, failed };
}

/**
 * Internal push send (X-Internal-Token) — for platform services like agent-teams
 * to notify a specific user (e.g. "your task needs input"). Bypasses the public
 * creator/peer checks; targets one user's subscriptions for an app.
 */
notificationRoutes.post('/notifications/send-internal', async (c) => {
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    return c.text('forbidden', 403);
  }
  const { userId, appId, title, body, url, icon, tag } = await c.req.json<{
    userId: string; appId: string; title: string; body: string; url?: string; icon?: string; tag?: string;
  }>();
  if (!userId || !appId || !title || !body) {
    return c.text('missing required fields: userId, appId, title, body', 400);
  }
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM push_subscriptions WHERE app_id = ?1 AND user_id = ?2',
  ).bind(appId, userId).all<PushSubscriptionRow>();
  const out = await sendPushToSubs(c.env, results, JSON.stringify({ title, body, url, icon, tag }));
  return c.json(out);
});

/** Public VAPID key — no auth needed. Apps fetch this to register push. */
notificationRoutes.get('/notifications/vapid-key', (c) => {
  return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY });
});

/** Subscribe to push notifications. Upserts the browser subscription in D1. */
notificationRoutes.post('/notifications/subscribe', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, endpoint, p256dh, auth } = await c.req.json<{
      appId: string;
      endpoint: string;
      p256dh: string;
      auth: string;
    }>();

    if (!appId || !endpoint || !p256dh || !auth) {
      return c.text('missing required fields: appId, endpoint, p256dh, auth', 400);
    }

    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO push_subscriptions (id, user_id, app_id, endpoint, p256dh, auth_secret, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = ?2, app_id = ?3, p256dh = ?5, auth_secret = ?6`,
    )
      .bind(id, user.id, appId, endpoint, p256dh, auth, Date.now())
      .run();

    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** Unsubscribe from push notifications. Deletes the subscription by endpoint. */
notificationRoutes.post('/notifications/unsubscribe', async (c) => {
  try {
    const user = await requireUser(c);
    const { endpoint } = await c.req.json<{ endpoint: string }>();

    if (!endpoint) return c.text('missing endpoint', 400);

    await c.env.DB.prepare(
      'DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2',
    )
      .bind(endpoint, user.id)
      .run();

    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** notify-user email caps (#209): the per-app budget is shared with app.email.send. */
const EMAIL_APP_DAILY_LIMIT = 100;
const EMAIL_RECIPIENT_DAILY_LIMIT = 10;
const EMAIL_MAX_TITLE = 150;
const EMAIL_MAX_BODY = 2000;
type NotifyChannel = 'push' | 'email' | 'both';
type EmailSkip = 'unsubscribed' | 'no_address' | 'not_member';

/** Any app role (the `member` row ensure-member writes on first sign-in) — keyed by id or login. */
async function isAppMember(db: D1Database, appId: string, userId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM app_roles
      WHERE app_id = ?1 AND (user_id = ?2 OR user_id = (SELECT login FROM users WHERE id = ?2))
      LIMIT 1`,
  ).bind(appId, userId).first();
  return row !== null;
}

/**
 * Peer-to-peer notification: a user of an app notifies another user of it.
 * `channel` (#209): `push` (default, unchanged) needs the caller to hold a push
 * subscription; `email` / `both` need the caller to be a member, and email only
 * goes to a member's provider-verified address, which the app never sees.
 * Limits: 30/min per sender and 10/min per recipient (every channel); email also
 * 100/day per app (shared with app.email.send) and 10/day per recipient.
 */
notificationRoutes.post('/notifications/notify-user', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, targetUserId, title, body, url, icon, tag, channel: rawChannel } = await c.req.json<{
      appId: string;
      targetUserId: string;
      title: string;
      body: string;
      url?: string;
      icon?: string;
      tag?: string;
      channel?: NotifyChannel;
    }>();

    if (!appId || !targetUserId || !title || !body) {
      return c.text('missing required fields: appId, targetUserId, title, body', 400);
    }
    const channel = rawChannel ?? 'push';
    if (!['push', 'email', 'both'].includes(channel)) return c.text('channel must be "push", "email" or "both"', 400);
    const wantsPush = channel !== 'email';
    const wantsEmail = channel !== 'push';

    if (wantsEmail) {
      if (!c.env.RESEND_API_KEY) return c.text('email not configured', 503);
      if (typeof title !== 'string' || title.length > EMAIL_MAX_TITLE) return c.text(`title too long for email (max ${EMAIL_MAX_TITLE} chars)`, 400);
      if (typeof body !== 'string' || body.length > EMAIL_MAX_BODY) return c.text(`body too long for email (max ${EMAIL_MAX_BODY} chars)`, 400);
      if (url !== undefined && !(await isAppOriginUrl(c.env.DB, appId, url))) {
        return c.text("url must be an https URL on the app's own origin", 400);
      }
      if (!(await isAppMember(c.env.DB, appId, user.id))) {
        return c.text('you must be a member of this app to email other users', 403);
      }
    } else {
      // Verify caller is a subscribed user of this app (proves active membership)
      const callerSub = await c.env.DB.prepare(
        'SELECT 1 FROM push_subscriptions WHERE app_id = ?1 AND user_id = ?2 LIMIT 1',
      ).bind(appId, user.id).first();
      if (!callerSub) {
        return c.text('you must be subscribed to this app to notify other users', 403);
      }
    }

    // Rate limit: 30 sends per minute per sender per app
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - 60;
    const senderCount = await c.env.DB.prepare(
      `SELECT COUNT(*) as n FROM notification_log
       WHERE sender_id = ?1 AND app_id = ?2 AND sent_at > ?3`,
    ).bind(user.id, appId, windowStart).first<{ n: number }>();
    if (senderCount && senderCount.n >= 30) {
      return c.text('rate limit exceeded: max 30 notifications per minute per app', 429);
    }

    // Rate limit: 10 pushes per minute per recipient (anti-spam)
    const recipientCount = await c.env.DB.prepare(
      `SELECT COUNT(*) as n FROM notification_log
       WHERE target_user_id = ?1 AND app_id = ?2 AND sent_at > ?3`,
    ).bind(targetUserId, appId, windowStart).first<{ n: number }>();
    if (recipientCount && recipientCount.n >= 10) {
      return c.text('rate limit exceeded: target user receiving too many notifications', 429);
    }

    // Email decision BEFORE anything is sent: a daily-cap 429 must not follow a push.
    let emailTo: string | null = null;
    let skipped: EmailSkip | undefined;
    if (wantsEmail) {
      const optedOut = await c.env.DB.prepare(
        'SELECT 1 FROM notification_email_optout WHERE app_id = ?1 AND user_id = ?2',
      ).bind(appId, targetUserId).first();
      if (!(await isAppMember(c.env.DB, appId, targetUserId))) skipped = 'not_member';
      else if (optedOut) skipped = 'unsubscribed';
      else {
        // users.email is the address an OAuth provider verified; credential_email
        // is unverified and never used here (see migration 0042).
        const row = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(targetUserId).first<{ email: string | null }>();
        if (row?.email && isLikelyEmail(row.email)) emailTo = row.email;
        else skipped = 'no_address';
      }
      if (emailTo) {
        const dayAgo = now - 86400;
        const appUsage = await c.env.DB.prepare(
          'SELECT COUNT(*) as n FROM email_usage WHERE app_id = ?1 AND sent_at > ?2',
        ).bind(appId, dayAgo).first<{ n: number }>();
        if (appUsage && appUsage.n >= EMAIL_APP_DAILY_LIMIT) return c.text(`daily email limit reached (${EMAIL_APP_DAILY_LIMIT}/day per app)`, 429);
        const recipientUsage = await c.env.DB.prepare(
          'SELECT COUNT(*) as n FROM email_usage WHERE app_id = ?1 AND target_user_id = ?2 AND sent_at > ?3',
        ).bind(appId, targetUserId, dayAgo).first<{ n: number }>();
        if (recipientUsage && recipientUsage.n >= EMAIL_RECIPIENT_DAILY_LIMIT) {
          return c.text(`daily email limit reached for this recipient (${EMAIL_RECIPIENT_DAILY_LIMIT}/day)`, 429);
        }
      }
    }

    // Log this send for rate limiting
    await c.env.DB.prepare(
      'INSERT INTO notification_log (sender_id, app_id, target_user_id, sent_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(user.id, appId, targetUserId, now).run();

    // #213: caller-written text leaves under the platform's sending domain, so it
    // is moderated before anything is sent. Only when an email will really go out
    // (cost), after the attempt is logged above (so rejected attempts still count
    // toward the per-minute limits), and fail-closed: a model error is a 503,
    // never an implicit "safe". Push-only calls never reach this.
    if (emailTo) {
      const moderation = await moderateText(c.env.AI, `${title}\n\n${body}`);
      console.log(JSON.stringify({
        event: 'notify_user_moderation', app_id: appId, sender_id: user.id, target_user_id: targetUserId, verdict: moderation.verdict,
        ...(moderation.verdict === 'unsafe' && { categories: moderation.categories }),
        ...(moderation.verdict === 'error' && { reason: moderation.reason }),
      }));
      if (moderation.verdict === 'unsafe') {
        return c.json({ error: 'message rejected by content moderation', categories: moderation.categories }, 422);
      }
      if (moderation.verdict === 'error') {
        return c.text('email content moderation is unavailable; try again later', 503, { 'Retry-After': '60' });
      }
    }

    let result = { sent: 0, failed: 0 };
    if (wantsPush) {
      const subs = (await c.env.DB.prepare(
        'SELECT * FROM push_subscriptions WHERE app_id = ?1 AND user_id = ?2',
      ).bind(appId, targetUserId).all<PushSubscriptionRow>()).results;
      result = await sendPushToSubs(c.env, subs, JSON.stringify({ title, body, url, icon, tag }));
    }
    if (!wantsEmail) return c.json(result);
    if (!emailTo) return c.json({ ...result, email: 'skipped', skipped });

    // Reserve the daily slot before sending (check-then-act, as app.email.send does).
    const reserved = await c.env.DB.prepare(
      'INSERT INTO email_usage (app_id, user_id, sent_at, target_user_id) VALUES (?1, ?2, ?3, ?4)',
    ).bind(appId, user.id, now, targetUserId).run();
    const apiBase = c.env.APP_BASE ?? 'https://api.proappstore.online';
    const unsubscribeUrl = `${apiBase}/v1/notifications/email/unsubscribe?t=${await signUnsubscribeToken(c.env.SESSION_SIGNING_KEY, appId, targetUserId)}`;
    const message = renderNotifyEmail({ appId, title, body, link: url ?? `https://${appId}.proappstore.online/`, unsubscribeUrl });
    try {
      await sendEmail(
        { apiKey: c.env.RESEND_API_KEY!, from: c.env.EMAIL_FROM ?? 'ProAppStore <noreply@proappstore.online>' },
        {
          to: emailTo,
          ...message,
          headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        },
      );
    } catch (err) {
      await c.env.DB.prepare('DELETE FROM email_usage WHERE id = ?1').bind(reserved.meta.last_row_id).run();
      console.error('[notify-user] email send failed', err instanceof Error ? err.message : err);
      return channel === 'email' ? c.text('email send failed', 502) : c.json({ ...result, email: 'failed' });
    }
    return c.json({ ...result, email: 'sent' });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

const unsubscribePage = (message: string, form?: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Email preferences</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><p>${message}</p>${form ?? ''}</body></html>`;

/**
 * One-click unsubscribe from an app's notify-user emails (#209). GET shows a
 * confirmation (link scanners prefetch GETs, so it changes nothing); POST — the
 * button, or a mail client's RFC 8058 List-Unsubscribe-Post — records the opt-out.
 * The signed token is the authority: it names exactly one (app, user).
 */
notificationRoutes.get('/notifications/email/unsubscribe', async (c) => {
  const token = c.req.query('t') ?? '';
  const who = await verifyUnsubscribeToken(c.env.SESSION_SIGNING_KEY, token);
  if (!who) return c.html(unsubscribePage('This unsubscribe link is not valid.'), 400);
  const action = `?t=${encodeURIComponent(token)}`;
  return c.html(unsubscribePage(
    `Stop emails from <strong>${who.appId.replace(/[^a-z0-9-]/g, '')}</strong>?`,
    `<form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>`,
  ));
});

notificationRoutes.post('/notifications/email/unsubscribe', async (c) => {
  const who = await verifyUnsubscribeToken(c.env.SESSION_SIGNING_KEY, c.req.query('t') ?? '');
  if (!who) return c.html(unsubscribePage('This unsubscribe link is not valid.'), 400);
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO notification_email_optout (app_id, user_id, created_at) VALUES (?1, ?2, ?3)',
  ).bind(who.appId, who.userId, Date.now()).run();
  return c.html(unsubscribePage(`You will no longer receive emails from <strong>${who.appId.replace(/[^a-z0-9-]/g, '')}</strong>.`));
});

/** Send push notification. Caller must be app creator. */
notificationRoutes.post('/notifications/send', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, userId, title, body, url, icon, tag } = await c.req.json<{
      appId: string;
      userId?: string;
      title: string;
      body: string;
      url?: string;
      icon?: string;
      tag?: string;
    }>();

    if (!appId || !title || !body) {
      return c.text('missing required fields: appId, title, body', 400);
    }

    // Verify sender is app creator
    const app = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?1').bind(appId).first<{ creator_id: string }>();
    if (!app || app.creator_id !== user.id) {
      return c.text('only the app creator can send notifications', 403);
    }

    // Fetch target subscriptions
    let subs: PushSubscriptionRow[];
    if (userId) {
      const result = await c.env.DB.prepare(
        'SELECT * FROM push_subscriptions WHERE app_id = ?1 AND user_id = ?2',
      ).bind(appId, userId).all<PushSubscriptionRow>();
      subs = result.results;
    } else {
      const result = await c.env.DB.prepare(
        'SELECT * FROM push_subscriptions WHERE app_id = ?1',
      ).bind(appId).all<PushSubscriptionRow>();
      subs = result.results;
    }

    webpush.setVapidDetails(
      'mailto:push@proappstore.online',
      c.env.VAPID_PUBLIC_KEY,
      c.env.VAPID_PRIVATE_KEY,
    );

    const payload = JSON.stringify({ title, body, url, icon, tag });
    let sent = 0;
    let failed = 0;
    const deadEndpoints: string[] = [];

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth_secret },
            },
            payload,
          );
          sent++;
        } catch (err: any) {
          failed++;
          // Clean up dead subscriptions (browser unsubscribed or endpoint expired)
          if (err?.statusCode === 410 || err?.statusCode === 404) {
            deadEndpoints.push(sub.endpoint);
          }
        }
      }),
    );

    // Batch-delete dead endpoints
    if (deadEndpoints.length > 0) {
      const placeholders = deadEndpoints.map((_, i) => `?${i + 1}`).join(',');
      await c.env.DB.prepare(
        `DELETE FROM push_subscriptions WHERE endpoint IN (${placeholders})`,
      )
        .bind(...deadEndpoints)
        .run();
    }

    // Fire webhook (non-blocking)
    if (sent > 0) {
      const promise = dispatchWebhook(c.env.DB, appId, 'notification.sent', {
        appId,
        userId: userId ?? null,
        title,
        sent,
        failed,
      });
      try { c.executionCtx.waitUntil(promise); } catch { /* no executionCtx in tests */ }
    }

    return c.json({ sent, failed });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
