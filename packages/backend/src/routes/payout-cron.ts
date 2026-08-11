import { Hono } from 'hono';
import type { Env } from '../types.js';
import { Stripe } from '../lib/stripe.js';
import { internalTokenOk } from '@proappstore/build-core';

/**
 * Monthly payout cron for the services marketplace.
 *
 *   POST /internal/payouts/run   (protected by INTERNAL_TOKEN)
 *
 * Aggregates unpaid developer earnings from delivered engagements, transfers
 * the money to each developer's Stripe Connect account, records the payout,
 * and marks the engagements as paid. Idempotent: running twice in the same
 * month is a safe no-op (keyed by developer_id + payout_month UNIQUE index).
 *
 * CLAWBACK NETTING (#85): a refund on an already-settled engagement cannot be
 * recovered by decrementing that engagement — this query never looks at settled
 * rows again — so the shortfall is banked in `developer_clawbacks` and netted
 * here against the developer's next earnings. Debt larger than the month's
 * earnings carries forward rather than being written off.
 */

export const payoutCronRoutes = new Hono<{ Bindings: Env }>();

interface UnpaidRow {
  developer_id: string;
  total_cents: number;
  eng_count: number;
  eng_ids: string;
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
  /** Debt netted off this payout, if any (#85). */
  clawbackAppliedCents?: number;
}

/**
 * A developer whose outstanding debt swallowed the whole month's earnings (#85).
 * No money moved, but the engagements ARE settled — they were consumed offsetting
 * the debt, and leaving them unpaid would re-count them next month against a
 * debt that had already been reduced.
 */
interface ClawbackSettlement {
  developerId: string;
  earnedCents: number;
  clawbackAppliedCents: number;
  remainingClawbackCents: number;
  engagementCount: number;
}

function currentPayoutMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

payoutCronRoutes.post('/internal/payouts/run', async (c) => {
  // Auth: require INTERNAL_TOKEN header (constant-time compare)
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: 'Stripe not configured' }, 503);
  }

  const payoutMonth = currentPayoutMonth();
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

  // 1. Find all developers with unpaid earnings from delivered engagements.
  //    "Unpaid" = status='delivered' AND payout_month IS NULL.
  //    eng_ids pins the exact engagements whose earnings are in this sum, so the
  //    mark-paid UPDATE can't stamp an engagement that flipped to 'delivered'
  //    mid-run (whose earnings were NOT transferred) — that would underpay the
  //    dev and permanently mark the engagement paid. Ids are UUIDs (no commas).
  const { results: unpaid } = await c.env.DB.prepare(
    `SELECT developer_id,
            SUM(total_dev_earned_cents) AS total_cents,
            COUNT(*) AS eng_count,
            GROUP_CONCAT(id) AS eng_ids
       FROM engagements
      WHERE status = 'delivered'
        AND payout_month IS NULL
        AND total_dev_earned_cents > 0
      GROUP BY developer_id`,
  ).all<UnpaidRow>();

  const succeeded: PayoutResult[] = [];
  const skipped: { developerId: string; reason: string }[] = [];
  const failed: { developerId: string; error: string }[] = [];
  const clawbackSettlements: ClawbackSettlement[] = [];

  for (const row of unpaid ?? []) {
    const earnedCents = Number(row.total_cents);
    if (earnedCents <= 0) continue;

    const engIdsAll = (row.eng_ids ?? '').split(',').filter(Boolean);

    // 1b. Net any outstanding refund debt (#85) BEFORE deciding what to pay.
    //     Read the observed value so the write below can compare-and-swap on it:
    //     two concurrent runs must not both subtract the same earnings from the
    //     same debt. Stripe's idempotency key guards the money; this guards the
    //     ledger.
    const debtRow = await c.env.DB.prepare(
      'SELECT pending_clawback_cents FROM developer_clawbacks WHERE developer_id = ?',
    ).bind(row.developer_id).first<{ pending_clawback_cents: number }>();
    const debtCents = Math.max(0, Number(debtRow?.pending_clawback_cents ?? 0));

    if (debtCents >= earnedCents) {
      // Debt swallows the month. No transfer, but the engagements ARE settled —
      // they have been consumed offsetting the debt. Leaving them unpaid would
      // re-count them next month against a debt already reduced by them, paying
      // the developer for work the client was refunded for a second time.
      const remaining = debtCents - earnedCents;
      const idPlaceholders = engIdsAll.map(() => '?').join(',');
      const settledAt = Date.now();
      try {
        await c.env.DB.batch([
          c.env.DB.prepare(
            `UPDATE developer_clawbacks
                SET pending_clawback_cents = ?, updated_at = ?
              WHERE developer_id = ? AND pending_clawback_cents = ?`,
          ).bind(remaining, settledAt, row.developer_id, debtCents),
          c.env.DB.prepare(
            `UPDATE engagements SET payout_month = ?
              WHERE id IN (${idPlaceholders}) AND payout_month IS NULL`,
          ).bind(payoutMonth, ...engIdsAll),
        ]);
        clawbackSettlements.push({
          developerId: row.developer_id,
          earnedCents,
          clawbackAppliedCents: earnedCents,
          remainingClawbackCents: remaining,
          engagementCount: Number(row.eng_count),
        });
      } catch (dbErr) {
        failed.push({
          developerId: row.developer_id,
          error: `clawback settlement failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        });
      }
      continue;
    }

    // Debt (if any) is smaller than the month's earnings: pay the difference.
    const amountCents = earnedCents - debtCents;

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
        // Idempotency at Stripe: the check at step 3 + the UNIQUE index only
        // guard the DB record, not the money. Without this, two concurrent cron
        // runs both pass step 3 and both transfer → the developer is paid twice.
        // Keyed by developer + month, so a duplicate request returns the same
        // transfer instead of creating a new one.
        idempotencyKey: `payout:${row.developer_id}:${payoutMonth}`,
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
    // Mark exactly the engagements captured in the snapshot sum — not a fresh
    // "all delivered + unpaid" scan, which could sweep in engagements delivered
    // after the snapshot whose earnings weren't in this transfer.
    const engIds = (row.eng_ids ?? '').split(',').filter(Boolean);
    const idPlaceholders = engIds.map(() => '?').join(',');
    const settlementStatements = [
      c.env.DB.prepare(
        `INSERT INTO service_payouts (id, developer_id, payout_month, amount_cents, engagement_count, stripe_transfer_id, stripe_connect_account_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(payoutId, row.developer_id, payoutMonth, amountCents, row.eng_count, transferId, connect.stripe_connect_account_id, now),
      c.env.DB.prepare(
        `UPDATE engagements
            SET payout_month = ?
          WHERE id IN (${idPlaceholders})
            AND payout_month IS NULL`,
      ).bind(payoutMonth, ...engIds),
    ];
    // Debt was fully absorbed by this payout — clear it in the same batch, and
    // only if it still holds the value we netted against (#85).
    if (debtCents > 0) {
      settlementStatements.push(
        c.env.DB.prepare(
          `UPDATE developer_clawbacks
              SET pending_clawback_cents = 0, updated_at = ?
            WHERE developer_id = ? AND pending_clawback_cents = ?`,
        ).bind(now, row.developer_id, debtCents),
      );
    }
    try {
      await c.env.DB.batch(settlementStatements);
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
      ...(debtCents > 0 ? { clawbackAppliedCents: debtCents } : {}),
    });
  }

  return c.json({
    payoutMonth,
    succeeded,
    skipped,
    failed,
    /** Developers whose refund debt consumed the whole month — no transfer (#85). */
    clawbackSettlements,
    summary: {
      totalTransferred: succeeded.length,
      totalAmountCents: succeeded.reduce((sum, p) => sum + p.amountCents, 0),
      totalSkipped: skipped.length,
      totalFailed: failed.length,
      // Debt recovered this run, across both paths: netted off a transfer, and
      // absorbed entirely by a settlement that moved no money.
      totalClawbackRecoveredCents:
        succeeded.reduce((sum, p) => sum + (p.clawbackAppliedCents ?? 0), 0)
        + clawbackSettlements.reduce((sum, s) => sum + s.clawbackAppliedCents, 0),
      totalClawbackOutstandingCents: clawbackSettlements.reduce(
        (sum, s) => sum + s.remainingClawbackCents,
        0,
      ),
    },
  });
});
