import { Hono } from 'hono';
import type { Env } from '../types.js';
import { oauthState } from '../lib/google-calendar-accounts.js';

export const googleCalendarRoutes = new Hono<{ Bindings: Env }>();

/** No token exchange here: the app must complete with its authenticated initiating PAS user. */
googleCalendarRoutes.get('/connectors/google-calendar/callback', async c => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  try {
    const state = c.req.query('state');
    const pending = await oauthState(c.env, state);
    const destination = new URL(pending.callback_url);
    const code = c.req.query('code');
    if (c.req.query('error')) destination.searchParams.set('error', 'google_cancelled');
    else if (code && code.length <= 4096) destination.searchParams.set('code', code);
    else return c.text('Missing Google response. Start again from app settings.', 400);
    destination.searchParams.set('state', state!);
    return c.redirect(destination.href, 302);
  } catch { return c.text('This Google connection request expired. Start again from app settings.', 400); }
});
