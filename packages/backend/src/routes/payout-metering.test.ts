import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEnv, mockD1, mockStmt } from '../test-helpers.js';
import { payoutUsageSql } from '../lib/payout-meter.js';
import { backfillLegacyUsage, reconcileAiGateway } from './payout-metering.js';

afterEach(() => vi.unstubAllGlobals());

describe('payout meter legacy backfill (#25)', () => {
  it('uses a deterministic event key, so a repeated backfill cannot increase a payout', async () => {
    const rows = [{ app_id: 'meetup', user_id: 'gh:42', day: '2026-06-01', session_seconds: 90, api_calls: 3 }];
    const db = mockD1(mockStmt({ all: { results: rows } }), mockStmt({ all: { results: rows } }));
    const meter = { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;
    const env = makeEnv({ PAYOUT_METER: meter }, db);

    await backfillLegacyUsage(env, '2026-06-01', '2026-06-01');
    await backfillLegacyUsage(env, '2026-06-01', '2026-06-01');

    const writes = (meter.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls;
    expect(writes).toHaveLength(2);
    expect(writes[0]![0].indexes).toEqual(writes[1]![0].indexes);
    expect(writes[0]![0].blobs[6]).toBe('d1:2026-06-01:meetup:gh:42');
    // The financial query groups by event_key and selects MAX(delta), not SUM,
    // which makes that replay a no-op in the source-of-truth calculation.
    expect(payoutUsageSql(0, 1)).toContain('GROUP BY app_id, actor, event_key');
    expect(payoutUsageSql(0, 1)).toContain('MAX(double1)');
  });
});

describe('AI Gateway payout reconciliation (#25)', () => {
  it('records provider/model/token/cost against metadata appId and ignores unattributed logs', async () => {
    const meter = { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;
    const env = makeEnv({
      PAYOUT_METER: meter,
      AI_GATEWAY_ID: 'pas-agent-teams',
      CF_AI_GATEWAY_API_TOKEN: 'gateway-read-token',
    });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ result: [
      { id: 'log-1', created_at: '2026-06-01T10:00:00.000Z', success: true, provider: 'anthropic', model: 'claude-sonnet-4-6', tokens_in: 12, tokens_out: 34, cost: 0.005, metadata: JSON.stringify({ appId: 'meetup', surface: 'agent-run' }) },
      { id: 'log-2', created_at: '2026-06-01T10:00:00.000Z', success: true, provider: 'openai', metadata: '{}' },
    ] }), { status: 200 })));

    const report = await reconcileAiGateway(env, '2026-06-01', '2026-06-01');

    expect(report).toEqual({ scanned: 2, written: 1, unattributed: 1 });
    expect((meter.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      indexes: ['aigw:log-1'],
      blobs: ['meetup', '', 'ai', 'ai-gateway', 'anthropic', 'claude-sonnet-4-6', 'aigw:log-1'],
      doubles: [0, 0, 12, 34, 0.005, expect.any(Number)],
    });
  });
});
