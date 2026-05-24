import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import webpush from 'web-push';
import type { Env, PushSubscriptionRow } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import { dispatchWebhook } from '../lib/webhook-dispatch.js';

export const notificationRoutes = new Hono<{ Bindings: Env }>();

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

/**
 * Peer-to-peer push: any subscribed user can notify another user in the same app.
 * Rate-limited: 30 pushes per user per minute per app.
 */
notificationRoutes.post('/notifications/notify-user', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, targetUserId, title, body, url, icon, tag } = await c.req.json<{
      appId: string;
      targetUserId: string;
      title: string;
      body: string;
      url?: string;
      icon?: string;
      tag?: string;
    }>();

    if (!appId || !targetUserId || !title || !body) {
      return c.text('missing required fields: appId, targetUserId, title, body', 400);
    }

    // Verify caller is a subscribed user of this app (proves active membership)
    const callerSub = await c.env.DB.prepare(
      'SELECT 1 FROM push_subscriptions WHERE app_id = ?1 AND user_id = ?2 LIMIT 1',
    ).bind(appId, user.id).first();
    if (!callerSub) {
      return c.text('you must be subscribed to this app to notify other users', 403);
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

    // Log this send for rate limiting
    await c.env.DB.prepare(
      'INSERT INTO notification_log (sender_id, app_id, target_user_id, sent_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(user.id, appId, targetUserId, now).run();

    // Fetch target user's subscriptions
    const result = await c.env.DB.prepare(
      'SELECT * FROM push_subscriptions WHERE app_id = ?1 AND user_id = ?2',
    ).bind(appId, targetUserId).all<PushSubscriptionRow>();
    const subs = result.results;

    if (subs.length === 0) {
      return c.json({ sent: 0, failed: 0 });
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
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_secret } },
            payload,
          );
          sent++;
        } catch (err: any) {
          failed++;
          if (err?.statusCode === 410 || err?.statusCode === 404) {
            deadEndpoints.push(sub.endpoint);
          }
        }
      }),
    );

    if (deadEndpoints.length > 0) {
      const placeholders = deadEndpoints.map((_, i) => `?${i + 1}`).join(',');
      await c.env.DB.prepare(
        `DELETE FROM push_subscriptions WHERE endpoint IN (${placeholders})`,
      ).bind(...deadEndpoints).run();
    }

    return c.json({ sent, failed });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
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
