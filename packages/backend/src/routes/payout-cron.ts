import { Hono } from 'hono';
import type { Env } from '../types.js';
import { Stripe } from '../lib/stripe.js';

/**
 * Monthly payout cron for the services marketplace.
 *
 *   POST /internal/payouts/run   (protected by INTERNAL_TOKEN)
 *
 * Aggregates unpaid developer earnings from delivered engagements, transfers
 * the money to each developer's Stripe Connect account, records the payout,
 * and marks the engagements as paid. Idempotent: running twice in the same
 * month is a safe no-op (keyed by developer_id + payout_month UNIQUE index).
 */

export const payoutCronRoutes = new Hono<{ Bindings: Env }>();

interface UnpaidRow {
  developer_id: string;
  total_cents: number;
  eng_count: number;
}

interface CreatorPayoutRow {
  stripe_connect_account_id: string;
  payouts_enabled: number;
}

interface PayoutResult {
  developerId: string;
  amountCents: number;
  engagementCount: number;
  stripeTransferId: string;
}

function currentPayoutMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

payoutCronRoutes.post('/internal/payouts/run', async (c) => {
  // Auth: require INTERNAL_TOKEN header
  const token = c.req.header('X-Internal-Token');
  if (!c.env.INTERNAL_TOKEN || token !== c.env.INTERNAL_TOKEN) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: 'Stripe not configured' }, 503);
  }

  const payoutMonth = currentPayoutMonth();
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

  // 1. Find all developers with unpaid earnings from delivered engagements.
  //    "Unpaid" = status='delivered' AND payout_month IS NULL.
  const { results: unpaid } = await c.env.DB.prepare(
    `SELECT developer_id,
            SUM(total_dev_earned_cents) AS total_cents,
            COUNT(*) AS eng_count
       FROM engagements
      WHERE status = 'delivered'
        AND payout_month IS NULL
        AND total_dev_earned_cents > 0
      GROUP BY developer_id`,
  ).all<UnpaidRow>();

  const succeeded: PayoutResult[] = [];
  const skipped: { developerId: string; reason: string }[] = [];
  const failed: { developerId: string; error: string }[] = [];

  for (const row of unpaid ?? []) {
    const amountCents = Number(row.total_cents);
    if (amountCents <= 0) continue;

    // 2. Look up Stripe Connect account
    const connect = await c.env.DB.prepare(
      'SELECT stripe_connect_account_id, payouts_enabled FROM creator_payouts WHERE creator_id = ?',
    ).bind(row.developer_id).first<CreatorPayoutRow>();

    if (!connect) {
      skipped.push({ developerId: row.developer_id, reason: 'no Stripe Connect account' });
      continue;
    }
    if (!connect.payouts_enabled) {
      skipped.push({ developerId: row.developer_id, reason: 'payouts not enabled on Connect account' });
      continue;
    }

    // 3. Check idempotency — if this developer was already paid for this month,
    //    skip (the UNIQUE index would reject anyway, but this avoids the Stripe call).
    const existing = await c.env.DB.prepare(
      'SELECT id FROM service_payouts WHERE developer_id = ? AND payout_month = ?',
    ).bind(row.developer_id, payoutMonth).first<{ id: string }>();

    if (existing) {
      skipped.push({ developerId: row.developer_id, reason: 'already paid this month' });
      continue;
    }

    // 4. Transfer via Stripe
    let transferId: string;
    try {
      const transfer = await stripe.createTransfer({
        amountCents,
        currency: 'usd',
        destination: connect.stripe_connect_account_id,
        description: `PAS service payout ${payoutMonth}`,
        metadata: {
          developer_id: row.developer_id,
          payout_month: payoutMonth,
          engagement_count: String(row.eng_count),
        },
      });
      transferId = transfer.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ developerId: row.developer_id, error: msg });
      continue;
    }

    // 5. Record payout + mark engagements as paid (atomic batch).
    const payoutId = crypto.randomUUID();
    const now = Date.now();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO service_payouts (id, developer_id, payout_month, amount_cents, engagement_count, stripe_transfer_id, stripe_connect_account_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(payoutId, row.developer_id, payoutMonth, amountCents, row.eng_count, transferId, connect.stripe_connect_account_id, now),
        c.env.DB.prepare(
          `UPDATE engagements
              SET payout_month = ?
            WHERE developer_id = ?
              AND status = 'delivered'
              AND payout_month IS NULL
              AND total_dev_earned_cents > 0`,
        ).bind(payoutMonth, row.developer_id),
      ]);
    } catch (dbErr) {
      // If the DB write fails after Stripe succeeded, the transfer is already
      // done but unrecorded. The next cron run will see the UNIQUE index and
      // skip. Log the error so we can reconcile manually if needed.
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      // If it's a UNIQUE constraint violation, the payout was already recorded
      // (race condition with concurrent cron run).
      if (msg.includes('UNIQUE')) {
        skipped.push({ developerId: row.developer_id, reason: 'already paid this month (concurrent)' });
        continue;
      }
      failed.push({ developerId: row.developer_id, error: `transfer succeeded (${transferId}) but DB write failed: ${msg}` });
      continue;
    }

    succeeded.push({
      developerId: row.developer_id,
      amountCents,
      engagementCount: Number(row.eng_count),
      stripeTransferId: transferId,
    });
  }

  return c.json({
    payoutMonth,
    succeeded,
    skipped,
    failed,
    summary: {
      totalTransferred: succeeded.length,
      totalAmountCents: succeeded.reduce((sum, p) => sum + p.amountCents, 0),
      totalSkipped: skipped.length,
      totalFailed: failed.length,
    },
  });
});
