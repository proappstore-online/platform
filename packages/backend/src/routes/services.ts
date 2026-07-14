import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import { internalTokenOk } from '@proappstore/build-core';
import { Stripe } from '../lib/stripe.js';

/**
 * Services marketplace — Phase 1: developer profiles + client balances.
 *
 *   GET    /services/developers            Public dev directory
 *   GET    /services/developers/:id        Single dev profile
 *   PUT    /services/profile               Create/update own profile (auth)
 *   PATCH  /services/profile/availability  Toggle available/unavailable
 *
 *   GET    /services/balance               Current balance (auth)
 *   POST   /services/balance/deposit       Stripe checkout for top-up (min $10)
 *   POST   /services/balance/confirm       Webhook-free: confirm after redirect
 *   GET    /services/balance/transactions  Ledger (auth)
 */

export const servicesRoutes = new Hono<{ Bindings: Env }>();

// ── Developer profiles ──────────────────────────────────────

interface DevProfileRow {
  creator_id: string;
  prompt_rate_cents: number;
  bio_services: string | null;
  available: number;
  quality_score: number | null;
  avg_prompt_length: number | null;
  median_response_time_ms: number | null;
  completed_engagements: number;
  avg_rating: number | null;
  rating_count: number;
  created_at: number;
  updated_at: number;
}

function profileDto(row: DevProfileRow, extra?: { login?: string | undefined; avatarUrl?: string | undefined }) {
  return {
    creatorId: row.creator_id,
    promptRateCents: row.prompt_rate_cents,
    bioServices: row.bio_services,
    available: row.available === 1,
    qualityScore: row.quality_score,
    avgPromptLength: row.avg_prompt_length,
    medianResponseTimeMs: row.median_response_time_ms,
    completedEngagements: row.completed_engagements,
    avgRating: row.avg_rating,
    ratingCount: row.rating_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(extra?.login ? { login: extra.login } : {}),
    ...(extra?.avatarUrl ? { avatarUrl: extra.avatarUrl } : {}),
  };
}

function computeBadges(row: DevProfileRow): string[] {
  const badges: string[] = [];
  if (row.completed_engagements >= 5) badges.push('verified-developer');
  if ((row.avg_rating ?? 0) >= 4.5 && row.rating_count >= 3) badges.push('top-rated');
  if (row.completed_engagements >= 20) badges.push('expert');
  return badges;
}

// Public: list developers with optional filters
// ?minRate=50&maxRate=500 — cents range
// ?minRating=4 — minimum avg rating (1-5)
// ?q=keyword — search login and bio
// ?sort=rate|rating|engagements (default: quality)
servicesRoutes.get('/services/developers', async (c) => {
  const minRate = parseInt(c.req.query('minRate') ?? '') || 0;
  const maxRate = parseInt(c.req.query('maxRate') ?? '') || 999999;
  const minRating = parseFloat(c.req.query('minRating') ?? '') || 0;
  const q = c.req.query('q')?.trim().toLowerCase() ?? '';
  const sort = c.req.query('sort') ?? 'quality';

  const orderBy = sort === 'rate' ? 'd.prompt_rate_cents ASC'
    : sort === 'rating' ? 'd.avg_rating DESC NULLS LAST'
    : sort === 'engagements' ? 'd.completed_engagements DESC'
    : 'd.quality_score DESC NULLS LAST, d.completed_engagements DESC';

  let where = 'd.available = 1 AND d.prompt_rate_cents >= ? AND d.prompt_rate_cents <= ?';
  const binds: unknown[] = [minRate, maxRate];

  if (minRating > 0) {
    where += ' AND d.avg_rating >= ?';
    binds.push(minRating);
  }
  if (q) {
    where += ' AND (LOWER(u.login) LIKE ? OR LOWER(d.bio_services) LIKE ?)';
    binds.push(`%${q}%`, `%${q}%`);
  }

  const rows = await c.env.DB.prepare(
    `SELECT d.*, u.login, u.avatar_url,
       (SELECT COUNT(*) FROM apps WHERE creator_id = d.creator_id) AS app_count
     FROM dev_profiles d
     LEFT JOIN users u ON u.id = d.creator_id
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT 50`,
  ).bind(...binds).all<DevProfileRow & { login: string | null; avatar_url: string | null; app_count: number }>();

  return c.json({
    developers: (rows.results ?? []).map((r) => ({
      ...profileDto(r, { login: r.login ?? undefined, avatarUrl: r.avatar_url ?? undefined }),
      appCount: r.app_count,
      badges: computeBadges(r),
    })),
  });
});

// Public: single developer profile
servicesRoutes.get('/services/developers/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT d.*, u.login, u.avatar_url
     FROM dev_profiles d
     LEFT JOIN users u ON u.id = d.creator_id
     WHERE d.creator_id = ?`,
  ).bind(id).first<DevProfileRow & { login: string | null; avatar_url: string | null }>();

  if (!row) return c.json({ error: 'developer not found' }, 404);
  return c.json(profileDto(row, { login: row.login ?? undefined, avatarUrl: row.avatar_url ?? undefined }));
});

// Auth: get own dev profile (returns null fields if not yet created)
servicesRoutes.get('/services/profile', async (c) => {
  try {
    const user = await requireUser(c);
    const row = await c.env.DB.prepare('SELECT * FROM dev_profiles WHERE creator_id = ?')
      .bind(user.id).first<DevProfileRow>();
    if (!row) return c.json({ exists: false });
    return c.json({ exists: true, ...profileDto(row) });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// Auth: create or update own dev profile
servicesRoutes.put('/services/profile', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<{
      promptRateCents?: number;
      bioServices?: string;
      available?: boolean;
    }>();

    const rate = Math.round(body.promptRateCents ?? 100);
    if (!Number.isFinite(rate) || rate < 10 || rate > 5000) return c.json({ error: 'promptRateCents must be an integer 10-5000' }, 400);
    if (body.bioServices && body.bioServices.length > 2000) return c.json({ error: 'bioServices too long (max 2000)' }, 400);

    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO dev_profiles (creator_id, prompt_rate_cents, bio_services, available, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(creator_id) DO UPDATE SET
         prompt_rate_cents = excluded.prompt_rate_cents,
         bio_services = excluded.bio_services,
         available = excluded.available,
         updated_at = excluded.updated_at`,
    ).bind(
      user.id,
      rate,
      body.bioServices ?? null,
      body.available !== false ? 1 : 0,
      now,
      now,
    ).run();

    const row = await c.env.DB.prepare('SELECT * FROM dev_profiles WHERE creator_id = ?')
      .bind(user.id).first<DevProfileRow>();
    return c.json(profileDto(row!));
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// Auth: toggle availability
servicesRoutes.patch('/services/profile/availability', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<{ available: boolean }>();

    const result = await c.env.DB.prepare(
      'UPDATE dev_profiles SET available = ?, updated_at = ? WHERE creator_id = ?',
    ).bind(body.available ? 1 : 0, Date.now(), user.id).run();

    if (!result.meta.changes) return c.json({ error: 'profile not found — create one first' }, 404);
    return c.json({ available: body.available });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// ── Developer earnings ──────────────────────────────────────

// Auth: earnings breakdown for the developer
servicesRoutes.get('/services/earnings', async (c) => {
  try {
    const user = await requireUser(c);

    // Total earnings across all engagements
    const totals = await c.env.DB.prepare(
      `SELECT
         COUNT(*) AS total_engagements,
         SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(total_dev_earned_cents) AS total_earned_cents,
         SUM(prompts_count) AS total_prompts
       FROM engagements WHERE developer_id = ?`,
    ).bind(user.id).first<{
      total_engagements: number; delivered: number; active: number;
      total_earned_cents: number; total_prompts: number;
    }>();

    // Per-engagement breakdown (recent 20)
    const engagements = await c.env.DB.prepare(
      `SELECT e.id, e.status, e.prompt_rate_cents, e.prompts_count,
              e.total_dev_earned_cents, e.total_charged_cents, e.created_at, e.updated_at,
              u.login AS client_login
       FROM engagements e
       LEFT JOIN users u ON u.id = e.client_id
       WHERE e.developer_id = ?
       ORDER BY e.updated_at DESC LIMIT 20`,
    ).bind(user.id).all<Record<string, unknown>>();

    // Connect status (can they actually receive payouts?)
    const connect = await c.env.DB.prepare(
      'SELECT charges_enabled, payouts_enabled, details_submitted FROM creator_payouts WHERE creator_id = ?',
    ).bind(user.id).first<{ charges_enabled: number; payouts_enabled: number; details_submitted: number }>();

    return c.json({
      totalEarnedCents: totals?.total_earned_cents ?? 0,
      totalPrompts: totals?.total_prompts ?? 0,
      totalEngagements: totals?.total_engagements ?? 0,
      deliveredEngagements: totals?.delivered ?? 0,
      activeEngagements: totals?.active ?? 0,
      payoutsEnabled: (connect?.payouts_enabled ?? 0) === 1,
      connectOnboarded: (connect?.details_submitted ?? 0) === 1,
      engagements: (engagements.results ?? []).map((r) => ({
        id: r.id,
        clientLogin: r.client_login ?? null,
        status: r.status,
        promptRateCents: r.prompt_rate_cents,
        promptsCount: r.prompts_count,
        earnedCents: r.total_dev_earned_cents,
        chargedCents: r.total_charged_cents,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// ── Client: my requests ─────────────────────────────────────

// Auth: list the client's own build requests (all statuses, not just open)
servicesRoutes.get('/services/my-requests', async (c) => {
  try {
    const user = await requireUser(c);
    const rows = await c.env.DB.prepare(
      `SELECT r.*, u.login AS dev_login
       FROM build_requests r
       LEFT JOIN users u ON u.id = r.accepted_by
       WHERE r.client_id = ?
       ORDER BY r.created_at DESC LIMIT 50`,
    ).bind(user.id).all<Record<string, unknown>>();

    return c.json({
      requests: (rows.results ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        budgetCents: r.budget_cents,
        status: r.status,
        acceptedBy: r.accepted_by ?? null,
        devLogin: r.dev_login ?? null,
        engagementId: r.engagement_id ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// ── Stats recomputation ─────────────────────────────────────

// Recompute avg_prompt_length and median_response_time_ms for all developers
// from service_messages. Called periodically or on-demand.
servicesRoutes.post('/services/recompute-stats', async (c) => {
  // Internal only — require INTERNAL_TOKEN (constant-time compare)
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Avg prompt length per developer
  const avgLens = await c.env.DB.prepare(
    `SELECT e.developer_id, AVG(LENGTH(m.body)) AS avg_len
     FROM service_messages m
     JOIN engagements e ON e.id = m.engagement_id
     WHERE m.sender_role = 'developer'
     GROUP BY e.developer_id`,
  ).all<{ developer_id: string; avg_len: number }>();

  const now = Date.now();
  let updated = 0;
  for (const row of avgLens.results ?? []) {
    await c.env.DB.prepare(
      'UPDATE dev_profiles SET avg_prompt_length = ?, updated_at = ? WHERE creator_id = ?',
    ).bind(Math.round(row.avg_len), now, row.developer_id).run();
    updated++;
  }

  return c.json({ ok: true, updated });
});

// ── Client balance ──────────────────────────────────────────

interface BalanceRow {
  user_id: string;
  balance_cents: number;
  total_deposited_cents: number;
  total_spent_cents: number;
  stripe_customer_id: string | null;
  created_at: number;
  updated_at: number;
}

// Auth: get current balance
servicesRoutes.get('/services/balance', async (c) => {
  try {
    const user = await requireUser(c);
    const row = await c.env.DB.prepare('SELECT * FROM client_balances WHERE user_id = ?')
      .bind(user.id).first<BalanceRow>();

    return c.json({
      balanceCents: row?.balance_cents ?? 0,
      totalDepositedCents: row?.total_deposited_cents ?? 0,
      totalSpentCents: row?.total_spent_cents ?? 0,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// Auth: create Stripe checkout session for balance top-up (min $10)
servicesRoutes.post('/services/balance/deposit', async (c) => {
  try {
    const user = await requireUser(c);
    if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripe not configured' }, 503);

    const body = await c.req.json<{ amountCents: number; successUrl: string; cancelUrl: string }>();
    if (!body.amountCents || body.amountCents < 1000) {
      return c.json({ error: 'minimum deposit is $10.00 (1000 cents)' }, 400);
    }
    if (body.amountCents > 100000) {
      return c.json({ error: 'maximum deposit is $1000.00' }, 400);
    }
    if (!body.successUrl || !body.cancelUrl) {
      return c.json({ error: 'successUrl and cancelUrl required' }, 400);
    }

    // Validate redirect URLs
    for (const url of [body.successUrl, body.cancelUrl]) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        const ok = host === 'localhost' || host === '127.0.0.1' ||
          host === 'proappstore.online' || host.endsWith('.proappstore.online') ||
          host.endsWith('.pages.dev');
        if (!ok) return c.json({ error: 'redirect URLs must be on proappstore.online or localhost' }, 400);
      } catch {
        return c.json({ error: 'invalid redirect URL' }, 400);
      }
    }

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

    // Ensure the user has a Stripe customer ID
    let row = await c.env.DB.prepare('SELECT * FROM client_balances WHERE user_id = ?')
      .bind(user.id).first<BalanceRow>();

    if (!row) {
      const customer = await stripe.createCustomer({
        metadata: { user_id: user.id, login: user.login },
      });
      const now = Date.now();
      await c.env.DB.prepare(
        `INSERT INTO client_balances (user_id, balance_cents, total_deposited_cents, total_spent_cents, stripe_customer_id, created_at, updated_at)
         VALUES (?, 0, 0, 0, ?, ?, ?)`,
      ).bind(user.id, customer.id, now, now).run();
      row = {
        user_id: user.id,
        balance_cents: 0,
        total_deposited_cents: 0,
        total_spent_cents: 0,
        stripe_customer_id: customer.id,
        created_at: now,
        updated_at: now,
      };
    } else if (!row.stripe_customer_id) {
      const customer = await stripe.createCustomer({
        metadata: { user_id: user.id, login: user.login },
      });
      await c.env.DB.prepare(
        'UPDATE client_balances SET stripe_customer_id = ?, updated_at = ? WHERE user_id = ?',
      ).bind(customer.id, Date.now(), user.id).run();
      row.stripe_customer_id = customer.id;
    }

    // Create a one-time payment checkout session
    const session = await stripe.createPaymentCheckout({
      customer: row.stripe_customer_id!,
      amountCents: body.amountCents,
      currency: 'usd',
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      metadata: { user_id: user.id, type: 'balance_deposit' },
    });

    return c.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    if (err instanceof Error && err.message.startsWith('Stripe')) {
      console.error('Stripe error:', err.message);
      return c.json({ error: 'Payment provider error. Please try again.' }, 502);
    }
    throw err;
  }
});

// Auth: confirm deposit after Stripe redirect (webhook-free path)
// Client calls this with the checkout session ID after returning from Stripe.
// We verify the session status and credit the balance.
servicesRoutes.post('/services/balance/confirm', async (c) => {
  try {
    const user = await requireUser(c);
    if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripe not configured' }, 503);

    const body = await c.req.json<{ sessionId: string }>();
    if (!body.sessionId) return c.json({ error: 'sessionId required' }, 400);

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
    const session = await stripe.getCheckoutSession(body.sessionId);

    if (session.payment_status !== 'paid') {
      return c.json({ error: 'payment not completed' }, 400);
    }
    if (session.metadata?.user_id !== user.id) {
      return c.json({ error: 'session does not belong to you' }, 403);
    }

    const amountCents = session.amount_total ?? 0;
    if (amountCents <= 0) return c.json({ error: 'invalid amount' }, 400);

    // Always use the Stripe session ID as the idempotency key (guaranteed
    // unique and present), not payment_intent (can be null for some payment methods).
    const piId = session.id ?? body.sessionId;
    const txId = crypto.randomUUID();
    const now = Date.now();

    // Idempotent credit: the UNIQUE index on stripe_payment_intent_id prevents
    // double-crediting even under concurrent confirm calls. If the INSERT fails
    // (constraint violation), the batch aborts and we return "already credited".
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO balance_transactions (id, user_id, type, amount_cents, stripe_payment_intent_id, description, created_at)
           VALUES (?, ?, 'deposit', ?, ?, ?, ?)`,
        ).bind(txId, user.id, amountCents, piId, `Deposit $${(amountCents / 100).toFixed(2)}`, now),
        c.env.DB.prepare(
          `UPDATE client_balances
           SET balance_cents = balance_cents + ?, total_deposited_cents = total_deposited_cents + ?, updated_at = ?
           WHERE user_id = ?`,
        ).bind(amountCents, amountCents, now, user.id),
      ]);
    } catch (batchErr) {
      // UNIQUE constraint violation = already credited (concurrent confirm)
      if (batchErr instanceof Error && batchErr.message.includes('UNIQUE')) {
        const bal = await c.env.DB.prepare('SELECT balance_cents FROM client_balances WHERE user_id = ?')
          .bind(user.id).first<{ balance_cents: number }>();
        return c.json({ balanceCents: bal?.balance_cents ?? 0, alreadyCredited: true });
      }
      throw batchErr;
    }

    const bal = await c.env.DB.prepare('SELECT balance_cents FROM client_balances WHERE user_id = ?')
      .bind(user.id).first<{ balance_cents: number }>();

    return c.json({ balanceCents: bal?.balance_cents ?? 0, credited: amountCents });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    if (err instanceof Error && err.message.startsWith('Stripe')) {
      console.error('Stripe error:', err.message);
      return c.json({ error: 'Payment provider error. Please try again.' }, 502);
    }
    throw err;
  }
});

// Auth: transaction history
servicesRoutes.get('/services/balance/transactions', async (c) => {
  try {
    const user = await requireUser(c);
    const rows = await c.env.DB.prepare(
      'SELECT * FROM balance_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
    ).bind(user.id).all<{
      id: string; user_id: string; type: string; amount_cents: number;
      engagement_id: string | null; stripe_payment_intent_id: string | null;
      description: string | null; created_at: number;
    }>();

    return c.json({
      transactions: (rows.results ?? []).map((r) => ({
        id: r.id,
        type: r.type,
        amountCents: r.amount_cents,
        engagementId: r.engagement_id,
        description: r.description,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
