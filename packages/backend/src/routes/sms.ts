import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';

export const smsRoutes = new Hono<{ Bindings: Env }>();

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
}

interface SmsSendResult {
  sent: number;
  failed: number;
}

/**
 * Send SMS. Caller must be the app creator (same gate as notifications/send).
 *
 * Two call shapes:
 *   { appId, to: "+15551234", message }                — single recipient
 *   { appId, to: ["+1555…","+1556…"], message }        — bulk recipients
 *
 * Numbers must be in E.164 format. The Worker proxies to Twilio's REST API.
 * Twilio credentials live in env and are never exposed to the client.
 */
smsRoutes.post('/sms/send', async (c) => {
  try {
    const user = await requireUser(c);

    if (!c.env.TWILIO_ACCOUNT_SID || !c.env.TWILIO_AUTH_TOKEN || !c.env.TWILIO_FROM_NUMBER) {
      return c.text('SMS not configured', 503);
    }

    const { appId, to, message } = await c.req.json<{
      appId: string;
      to: string | string[];
      message: string;
    }>();

    if (!appId || !to || !message) {
      return c.text('missing required fields: appId, to, message', 400);
    }

    const numbers = Array.isArray(to) ? to : [to];
    if (numbers.length === 0) return c.text('to must include at least one number', 400);
    for (const n of numbers) {
      if (!isE164(n)) return c.text(`invalid E.164 number: ${n}`, 400);
    }

    const app = await c.env.DB
      .prepare('SELECT creator_id FROM apps WHERE id = ?1')
      .bind(appId)
      .first<{ creator_id: string }>();
    if (!app || app.creator_id !== user.id) {
      return c.text('only the app creator can send SMS', 403);
    }

    const cfg: TwilioConfig = {
      accountSid: c.env.TWILIO_ACCOUNT_SID,
      authToken: c.env.TWILIO_AUTH_TOKEN,
      from: c.env.TWILIO_FROM_NUMBER,
    };

    const result = await sendViaTwilio(cfg, numbers, message);
    return c.json(result satisfies SmsSendResult);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

async function sendViaTwilio(
  cfg: TwilioConfig,
  numbers: string[],
  body: string,
): Promise<SmsSendResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`;
  const basic = btoa(`${cfg.accountSid}:${cfg.authToken}`);

  let sent = 0;
  let failed = 0;
  await Promise.allSettled(
    numbers.map(async (to) => {
      const form = new URLSearchParams({ From: cfg.from, To: to, Body: body });
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      if (res.ok) sent++;
      else failed++;
    }),
  );
  return { sent, failed };
}

function isE164(s: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(s);
}
