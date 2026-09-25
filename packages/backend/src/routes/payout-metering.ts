import { Hono } from 'hono';
import { internalTokenOk } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { APP_ID_RE } from './validation.js';
import {
  legacyUsageEventKey,
  legacyUsageOccurredAt,
  payoutActorId,
  type LegacyUsageRow,
  writePayoutUsagePoint,
} from '../lib/payout-meter.js';

export const payoutMeteringRoutes = new Hono<{ Bindings: Env }>();

interface GatewayLog {
  id: string;
  created_at: string;
  provider?: string;
  model?: string;
  success?: boolean;
  tokens_in?: number;
  tokens_out?: number;
  cost?: number;
  metadata?: string;
}

function day(value: string | undefined, fallback: string): string {
  const out = value ?? fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out) || !Number.isFinite(Date.parse(`${out}T00:00:00.000Z`))) {
    throw new Error('start and end must be YYYY-MM-DD');
  }
  return out;
}

function gatewayAppId(metadata: string | undefined): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { appId?: unknown };
    return typeof parsed.appId === 'string' && APP_ID_RE.test(parsed.appId) ? parsed.appId : null;
  } catch {
    return null;
  }
}

/**
 * Project old D1 daily data into the immutable payout meter. The deterministic
 * event key means a retry writes an identical AE row; payout SQL groups by that
 * key, so it cannot increase an eventual payout. D1 is read-only here.
 */
export async function backfillLegacyUsage(
  env: Env,
  startDay: string,
  endDay: string,
  limit = 500,
): Promise<{ scanned: number; written: number }> {
  const { results } = await env.DB.prepare(
    `SELECT app_id, user_id, day, session_seconds, api_calls
       FROM usage_daily
      WHERE day >= ? AND day <= ?
        -- This table predates the subscriber write gate. A backfill may only
        -- project rows for accounts that are still known to be subscribers;
        -- unknown/lapsed legacy rows are safer omitted than credited.
        AND EXISTS (
          SELECT 1 FROM subscriptions s
           WHERE s.user_id = usage_daily.user_id AND s.status = 'active'
        )
      ORDER BY day, app_id, user_id
      LIMIT ?`,
  ).bind(startDay, endDay, Math.min(Math.max(limit, 1), 2_000)).all<LegacyUsageRow>();
  for (const row of results ?? []) {
    writePayoutUsagePoint(env.PAYOUT_METER, {
      appId: row.app_id,
      actor: await payoutActorId(row.user_id, env.PAYOUT_METER_SALT),
      eventKey: legacyUsageEventKey(row),
      source: 'd1-backfill',
      occurredAt: legacyUsageOccurredAt(row.day),
      sessionSeconds: Number(row.session_seconds),
      apiCalls: Number(row.api_calls),
    });
  }
  return { scanned: results?.length ?? 0, written: results?.length ?? 0 };
}

/**
 * Reconcile the provider-recorded AI Gateway logs into AE. Gateway log IDs are
 * immutable event keys, so pages can overlap and the job can be re-run safely.
 * Unattributed legacy logs are reported but intentionally never guessed into an
 * app's payout record.
 */
export async function reconcileAiGateway(
  env: Env,
  startDay: string,
  endDay: string,
): Promise<{ scanned: number; written: number; unattributed: number }> {
  if (!env.CF_ACCOUNT_ID || !env.AI_GATEWAY_ID || !env.CF_AI_GATEWAY_API_TOKEN) {
    throw new Error('AI Gateway reconciliation is not configured');
  }
  let scanned = 0;
  let written = 0;
  let unattributed = 0;
  for (let page = 1; page <= 20; page++) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${env.AI_GATEWAY_ID}/logs`);
    url.searchParams.set('start_date', `${startDay}T00:00:00.000Z`);
    url.searchParams.set('end_date', `${endDay}T23:59:59.999Z`);
    url.searchParams.set('per_page', '50');
    url.searchParams.set('page', String(page));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.CF_AI_GATEWAY_API_TOKEN}` } });
    if (!res.ok) throw new Error(`AI Gateway logs failed (${res.status})`);
    const body = await res.json() as { result?: GatewayLog[] };
    const rows = body.result ?? [];
    scanned += rows.length;
    for (const row of rows) {
      if (!row.success) continue;
      const appId = gatewayAppId(row.metadata);
      if (!appId) { unattributed++; continue; }
      const occurredAt = Date.parse(row.created_at);
      if (!row.id || !Number.isFinite(occurredAt)) continue;
      writePayoutUsagePoint(env.PAYOUT_METER, {
        appId,
        actor: '',
        eventKey: `aigw:${row.id}`,
        source: 'ai-gateway',
        occurredAt,
        tokensIn: Number(row.tokens_in ?? 0),
        tokensOut: Number(row.tokens_out ?? 0),
        costUsd: Number(row.cost ?? 0),
        provider: String(row.provider ?? '').slice(0, 128),
        model: String(row.model ?? '').slice(0, 256),
      });
      written++;
    }
    if (rows.length < 50) break;
  }
  return { scanned, written, unattributed };
}

function internal(c: { req: { header(name: string): string | undefined }; env: Env }): boolean {
  return internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN);
}

payoutMeteringRoutes.post('/internal/payouts/backfill-usage', async (c) => {
  if (!internal(c)) return c.json({ error: 'forbidden' }, 403);
  try {
    const end = day(c.req.query('end'), new Date().toISOString().slice(0, 10));
    const start = day(c.req.query('start'), end);
    const limit = Number(c.req.query('limit') ?? 500);
    return c.json({ start, end, ...(await backfillLegacyUsage(c.env, start, end, limit)) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'backfill failed' }, 400);
  }
});

payoutMeteringRoutes.post('/internal/payouts/reconcile-ai-gateway', async (c) => {
  if (!internal(c)) return c.json({ error: 'forbidden' }, 403);
  try {
    const end = day(c.req.query('end'), new Date().toISOString().slice(0, 10));
    const start = day(c.req.query('start'), end);
    return c.json({ start, end, ...(await reconcileAiGateway(c.env, start, end)) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'reconciliation failed' }, 503);
  }
});
