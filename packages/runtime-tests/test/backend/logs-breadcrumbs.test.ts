import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetBurstState } from '../../../backend/src/lib/log-quota';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser } from './helpers';

// #392 on real D1: the SDK redacts a breadcrumb when it records it, and public
// ingestion redacts again — the second line of defence for a client that does not
// (an old SDK, a forged entry). Breadcrumbs ride in an error entry's
// `data.breadcrumbs`, so whatever a client sends there must arrive scrubbed while
// the trail itself (category, message, order) stays readable.

const APP = 'crumbs-demo';

beforeEach(async () => {
  mockNetwork();
  resetBurstState();
  await resetTables();
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
});

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJnaDoxIn0.c2lnbmF0dXJlLXZhbHVl';
const HEX = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(8);

describe('breadcrumbs are redacted again at ingest (#392)', () => {
  it('an email, bearer token, JWT, credential pair and long hex id in a breadcrumb never reach app_logs', async () => {
    const breadcrumbs = [
      { ts: 1, category: 'navigation', message: '/clubs/[id]' },
      { ts: 2, category: 'auth', message: 'signed in as ada@example.com', data: { header: 'Bearer abc.def-123' } },
      { ts: 3, category: 'network', message: `retry with ${JWT}`, data: { query: 'token=s3cr3t-value', session: HEX } },
      { ts: 4, category: 'room', message: 'reconnected', data: { attempt: 2 } },
    ];
    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/logs`, json('POST', {
      entries: [{ level: 'error', category: 'runtime', message: 'boom', ts: Date.now(), data: { breadcrumbs } }],
    }));
    expect(res.status).toBeLessThan(300);

    const row = await env.DB.prepare("SELECT data FROM app_logs WHERE app_id = ? AND message = 'boom'").bind(APP).first<{ data: string }>();
    expect(row).not.toBeNull();
    for (const secret of ['ada@example.com', 'abc.def-123', JWT, 's3cr3t-value', HEX]) expect(row!.data).not.toContain(secret);

    const stored = JSON.parse(row!.data) as { breadcrumbs: { ts: number; category: string; message: string; data?: Record<string, unknown> }[] };
    // The trail survives: same crumbs, same order, readable messages with the secrets masked.
    expect(stored.breadcrumbs.map((b) => [b.ts, b.category])).toEqual([[1, 'navigation'], [2, 'auth'], [3, 'network'], [4, 'room']]);
    expect(stored.breadcrumbs[1]).toMatchObject({ message: 'signed in as [email]', data: { header: 'Bearer [redacted]' } });
    expect(stored.breadcrumbs[2]).toMatchObject({ message: 'retry with [jwt]', data: { query: 'token=[redacted]', session: '[hex]' } });
    expect(stored.breadcrumbs[3]).toEqual({ ts: 4, category: 'room', message: 'reconnected', data: { attempt: 2 } });
  });
});
