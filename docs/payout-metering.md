# Payout metering and reconciliation

Creator usage-share payouts are calculated from the `pas_payout_meter` Workers
Analytics Engine dataset (#25). It is an append-only financial ledger, separate
from visitor analytics (`pas_analytics`), and is the only source read by
`GET /v1/payouts/me/preview`. The older `usage_daily` D1 table is retained for
heartbeat rate limiting and non-financial usage screens; it must never be used
to calculate or repair a payout.

## What is recorded

| Input | Attribution | Financial use |
|---|---|---|
| Verified SDK heartbeat | app id + salted, non-reversible subscriber pseudonym | Per-subscriber session-time share of the monthly subscription pool |
| AI Gateway log | app id from `cf-aig-metadata`, provider, model, tokens and provider-reported cost | App LLM-cost evidence, shown alongside the payout preview |

Agent Teams sends `cf-aig-metadata` only on gateway-routed requests, with
`appId` and a call surface. Direct fallback requests are deliberately not
invented into the gateway record. A gateway log without a valid `appId` is
reported as `unattributed` and is never guessed onto an app.

Subscriber IDs are SHA-256 pseudonyms salted with `PAYOUT_METER_SALT`; raw
account IDs do not enter Analytics Engine. Do not rotate that salt: it would
break a subscriber's cross-app weighting. Treat a needed rotation as a new
ledger epoch and document the cutover before any monthly close.

### Heartbeats claim each interval once (#320)

`POST /v1/usage/ping` records a heartbeat only for an active subscriber, from
the app's own mediated origin (#58). Its session time is bounded so that it can
never exceed wall-clock time, however many requests run at once:

- **Each heartbeat claims the interval since the last one.** It claims the time
  between the `(app, subscriber, day)` row's `last_seen` and its own arrival,
  capped at 90 s, in whole seconds. API calls are capped at 1,000, and at 20 per
  claimed second. The first heartbeat of a UTC day may claim up to 90 s.
- **The claim is a compare-and-swap.** The write applies only if `last_seen`
  still has the value the heartbeat read: `UPDATE … WHERE last_seen = <read>`,
  or `INSERT … ON CONFLICT DO NOTHING` for the day's first heartbeat. Of several
  concurrent heartbeats, one wins the interval. The others re-read, see the
  winner's `last_seen`, and claim only what remains, normally nothing.
- **The invariant:** every recorded second lies in exactly one interval
  `(previous last_seen, now]`, claimed by exactly one heartbeat. A meter event is
  written only for a heartbeat that won its interval. So 50 parallel heartbeats
  after 90 s record 90 s, not 4,500 s.
- **Whole seconds, remainder carried.** When elapsed time is what limits a
  claim, `last_seen` advances by exactly the seconds claimed, and the sub-second
  rest counts towards the next heartbeat. Rounding a fraction up would let
  heartbeats a few milliseconds apart each claim a second. When the requested
  delta is what limits it, the unclaimed time is dropped and `last_seen` moves
  to the heartbeat's arrival.
- **Retries and late arrivals claim nothing.** An immediate retry, or a
  heartbeat arriving after a later one (a delayed request, a skewed clock), finds
  no elapsed time. It answers `recorded: false, reason: 'no-elapsed-time'`,
  writes nothing, and never moves `last_seen` back.

`usage_daily` holds only the claim's state (`last_seen`) and a dashboard
projection. The meter events are the ledger.

## Required configuration

Backend Worker secrets:

- `PAYOUT_METER_SALT`: long random immutable secret for subscriber pseudonyms.
- `CF_ANALYTICS_API_TOKEN`: Account Analytics read for the AE SQL payout query.
- `CF_AI_GATEWAY_API_TOKEN`: AI Gateway Read for gateway-log reconciliation.

Backend Worker vars:

- `AI_GATEWAY_ID=pas-agent-teams` (with the existing `CF_ACCOUNT_ID`).

The `PAYOUT_METER` binding is declared in `packages/backend/wrangler.toml` as
`pas_payout_meter`. Deploy the backend after adding secrets; a heartbeat fails
closed if the meter or salt is absent, rather than accepting usage that cannot
be audited for payouts.

## Monthly close procedure

1. Reconcile gateway data for the period. The scheduled backend job does the
   current day hourly, but run this once across the full closing month before
   payout review:

   ```bash
   curl -X POST 'https://api.proappstore.online/v1/internal/payouts/reconcile-ai-gateway?start=2026-06-01&end=2026-06-30' \
     -H "X-Internal-Token: $INTERNAL_TOKEN"
   ```

2. For the one-time migration from the old rollup, backfill bounded windows.
   This is read-only against D1 and safe to repeat; use smaller date ranges if
   the response reaches `limit`. The legacy table predates the subscriber write
   gate, so the command only projects users still known to be active subscribers;
   it intentionally omits uncertain/lapsed legacy rows rather than crediting
   them.

   ```bash
   curl -X POST 'https://api.proappstore.online/v1/internal/payouts/backfill-usage?start=2026-01-01&end=2026-01-31&limit=500' \
     -H "X-Internal-Token: $INTERNAL_TOKEN"
   ```

3. Review each creator preview. `estimatedCents` is the subscriber-pool share;
   `aiCosts` is provider/model token and cost evidence, not a second revenue
   allocation. Investigate any `unattributed` gateway logs before treating the
   LLM-cost view as complete.

4. Keep the exported preview/reconciliation response with the accounting close.
   Re-running either job cannot increase a payout: every AE row has a stable
   event key and the payout SQL takes the maximum delta per key before summing.

## Incident handling

- **Preview says meter not configured / 503:** stop payout close, restore the
  binding and secrets, then backfill the affected interval from `usage_daily`.
- **Gateway reconciliation fails:** no payout share is lost; retry the same
  range after restoring the AI Gateway Read token. Do not substitute
  `cost_ledger`: it is an estimate, not the provider record.
- **Unattributed logs:** fix the Agent Teams metadata path and reconcile the
  range again. Historical logs with no metadata remain deliberately excluded.
- **Suspected replay:** rerun the same command; stable keys plus the `MAX` per
  key query make that a verification operation, not a second credit.
