import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import { Stripe } from '../lib/stripe.js';

/**
 * Stripe Connect onboarding for creators.
 *
 *   POST /v1/connect/onboard     Get a hosted-onboarding URL. Creates the
 *                                Express account on first call; reuses it on
 *                                subsequent calls (account-link is one-shot,
 *                                refreshes safely).
 *   GET  /v1/connect/status      Fresh status snapshot from Stripe. Updates
 *                                the cached flags in creator_payouts.
 *
 * No payout cron yet — that's a separate piece. This endpoint set just gets
 * creators connected so when the cron runs, every approved creator has a
 * `stripe_connect_account_id` to transfer to.
 */

export const connectRoutes = new Hono<{ Bindings: Env }>();

interface CreatorPayoutsRow {
  creator_id: string;
  stripe_connect_account_id: string;
  charges_enabled: number;
  payouts_enabled: number;
  details_submitted: number;
  country: string | null;
  created_at: number;
  updated_at: number;
}

function statusDto(row: CreatorPayoutsRow) {
  const charges = row.charges_enabled === 1;
  const payouts = row.payouts_enabled === 1;
  const details = row.details_submitted === 1;
  return {
    connected: true,
    stripeAccountId: row.stripe_connect_account_id,
    chargesEnabled: charges,
    payoutsEnabled: payouts,
    detailsSubmitted: details,
    country: row.country,
    needsAction: !details || !payouts,
    updatedAt: row.updated_at,
  };
}

connectRoutes.post('/connect/onboard', async (c) => {
  try {
    const user = await requireUser(c);
    if (!c.env.STRIPE_SECRET_KEY) {
      return c.text('Stripe not configured', 503);
    }
    const body = await c.req.json<{ returnUrl?: string; refreshUrl?: string; country?: string }>();
    if (!body.returnUrl || !body.refreshUrl) {
      return c.text('returnUrl and refreshUrl are required', 400);
    }
    // Prevent open redirect via Stripe onboarding
    for (const url of [body.returnUrl, body.refreshUrl]) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        const ok = host === 'localhost' || host === '127.0.0.1' ||
          host === 'proappstore.online' || host.endsWith('.proappstore.online') ||
          host.endsWith('.pages.dev');
        if (!ok) return c.text('redirect URLs must be on proappstore.online or localhost', 400);
      } catch {
        return c.text('invalid redirect URL', 400);
      }
    }

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

    // Re-use the account if one already exists.
    let row = await c.env.DB.prepare('SELECT * FROM creator_payouts WHERE creator_id = ?')
      .bind(user.id)
      .first<CreatorPayoutsRow>();

    if (!row) {
      // Build the params object incrementally so we don't pass `country: undefined`
      // under exactOptionalPropertyTypes. Stripe defaults to US when omitted.
      const createParams: { country?: string; metadata: Record<string, string> } = {
        metadata: { creator_id: user.id, github_login: user.login },
      };
      if (body.country) createParams.country = body.country;
      const account = await stripe.createConnectAccount(createParams);
      const now = Date.now();
      await c.env.DB.prepare(
        `INSERT INTO creator_payouts
           (creator_id, stripe_connect_account_id, charges_enabled, payouts_enabled, details_submitted, country, created_at, updated_at)
           VALUES (?, ?, 0, 0, 0, ?, ?, ?)`,
      )
        .bind(user.id, account.id, account.country ?? null, now, now)
        .run();
      row = {
        creator_id: user.id,
        stripe_connect_account_id: account.id,
        charges_enabled: 0,
        payouts_enabled: 0,
        details_submitted: 0,
        country: account.country ?? null,
        created_at: now,
        updated_at: now,
      };
    }

    // Generate a fresh onboarding URL.
    const link = await stripe.createAccountLink({
      account: row.stripe_connect_account_id,
      refreshUrl: body.refreshUrl,
      returnUrl: body.returnUrl,
    });
    return c.json({ url: link.url, stripeAccountId: row.stripe_connect_account_id });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    if (err instanceof Error && err.message.startsWith('Stripe')) {
      return c.json({ error: err.message }, 502);
    }
    throw err;
  }
});

connectRoutes.get('/connect/status', async (c) => {
  try {
    const user = await requireUser(c);
    const row = await c.env.DB.prepare('SELECT * FROM creator_payouts WHERE creator_id = ?')
      .bind(user.id)
      .first<CreatorPayoutsRow>();

    if (!row) {
      return c.json({ connected: false });
    }

    // Refresh from Stripe so the Console doesn't show stale flags after the
    // creator returns from hosted onboarding.
    if (c.env.STRIPE_SECRET_KEY) {
      try {
        const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
        const account = await stripe.getAccount(row.stripe_connect_account_id);
        const next: CreatorPayoutsRow = {
          ...row,
          charges_enabled: account.charges_enabled ? 1 : 0,
          payouts_enabled: account.payouts_enabled ? 1 : 0,
          details_submitted: account.details_submitted ? 1 : 0,
          country: account.country ?? row.country,
          updated_at: Date.now(),
        };
        await c.env.DB.prepare(
          `UPDATE creator_payouts
              SET charges_enabled = ?, payouts_enabled = ?, details_submitted = ?, country = ?, updated_at = ?
            WHERE creator_id = ?`,
        )
          .bind(
            next.charges_enabled,
            next.payouts_enabled,
            next.details_submitted,
            next.country,
            next.updated_at,
            user.id,
          )
          .run();
        return c.json(statusDto(next));
      } catch {
        // Stripe API hiccup — fall through to the cached row.
      }
    }

    return c.json(statusDto(row));
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
