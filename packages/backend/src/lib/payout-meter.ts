import { PAYOUT_METER_DATASET } from './telemetry-datasets.js';

/** Analytics Engine dataset that is the source of truth for usage-share payouts. */
export { PAYOUT_METER_DATASET };

export type PayoutMeterSource = 'sdk' | 'd1-backfill' | 'ai-gateway';

export interface PayoutUsagePoint {
  appId: string;
  /** Stable, salted pseudonym. Raw account ids never enter Analytics Engine. */
  actor: string;
  eventKey: string;
  source: PayoutMeterSource;
  occurredAt: number;
  sessionSeconds?: number;
  apiCalls?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  provider?: string;
  model?: string;
}

/**
 * Payout meter AE schema. Keep positions append-only: SQL reconciliation and
 * payout calculations intentionally name the raw blob/double columns.
 *
 * blob1 app, blob2 pseudonymous subscriber (empty for app-level AI cost),
 * blob3 metric, blob4 source, blob5 provider, blob6 model, blob7 event key;
 * double1 seconds, double2 API calls, double3/4 tokens, double5 USD,
 * double6 occurrence time in ms. Indexing by event key makes an accidental
 * replay coalesce safely in the read query rather than sampling together an
 * entire app's financial events.
 */
export function writePayoutUsagePoint(dataset: AnalyticsEngineDataset | undefined, point: PayoutUsagePoint): void {
  if (!dataset) throw new Error('payout metering is not configured (missing PAYOUT_METER binding)');
  dataset.writeDataPoint({
    indexes: [point.eventKey],
    blobs: [
      point.appId,
      point.actor,
      point.tokensIn || point.tokensOut || point.costUsd ? 'ai' : 'usage',
      point.source,
      point.provider ?? '',
      point.model ?? '',
      point.eventKey,
    ],
    doubles: [
      point.sessionSeconds ?? 0,
      point.apiCalls ?? 0,
      point.tokensIn ?? 0,
      point.tokensOut ?? 0,
      point.costUsd ?? 0,
      point.occurredAt,
    ],
  });
}

/** SHA-256 is sufficient here: the immutable operator-held salt prevents AE readers reversing account ids. */
export async function payoutActorId(userId: string, salt: string | undefined): Promise<string> {
  if (!salt) throw new Error('payout metering is not configured (missing PAYOUT_METER_SALT)');
  const bytes = new TextEncoder().encode(`${salt}:${userId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface LegacyUsageRow {
  app_id: string;
  user_id: string;
  day: string;
  session_seconds: number;
  api_calls: number;
}

/** A legacy daily rollup maps to one deterministic event, making replay harmless. */
export function legacyUsageEventKey(row: LegacyUsageRow): string {
  return `d1:${row.day}:${row.app_id}:${row.user_id}`;
}

export function legacyUsageOccurredAt(day: string): number {
  return Date.parse(`${day}T12:00:00.000Z`);
}

/**
 * Payout SQL deduplicates by the immutable event key before summing. This is
 * the cross-store idempotency boundary: AE is append-only, so writes can be
 * retried without ever increasing a payout.
 */
export function payoutUsageSql(startMs: number, endMs: number): string {
  return `SELECT app_id, actor, SUM(session_seconds) AS session_seconds
FROM (
  SELECT blob1 AS app_id, blob2 AS actor, blob7 AS event_key,
         MAX(double1) AS session_seconds
  FROM ${PAYOUT_METER_DATASET}
  WHERE blob3 = 'usage' AND double6 >= ${startMs} AND double6 < ${endMs}
  GROUP BY app_id, actor, event_key
)
GROUP BY app_id, actor`;
}

export function payoutAiCostSql(startMs: number, endMs: number): string {
  return `SELECT blob1 AS app_id, blob5 AS provider, blob6 AS model,
  SUM(cost_usd) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
FROM (
  SELECT blob1, blob5, blob6, blob7,
    MAX(double3) AS tokens_in, MAX(double4) AS tokens_out, MAX(double5) AS cost_usd
  FROM ${PAYOUT_METER_DATASET}
  WHERE blob3 = 'ai' AND double6 >= ${startMs} AND double6 < ${endMs}
  GROUP BY blob1, blob5, blob6, blob7
)
GROUP BY app_id, provider, model`;
}
