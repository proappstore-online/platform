import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function mockStmt(opts: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 0 } }),
  };
}

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare };
}

function makeEnv(db?: ReturnType<typeof mockD1>) {
  return {
    DB: (db ?? mockD1()) as unknown as D1Database,
    STORAGE: { put: vi.fn() } as unknown as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'p',
    VAPID_PRIVATE_KEY: 'q',
  };
}


describe('GET /v1/apps/:id/listing', () => {
  it('returns empty DTO for an owned app with no listing row yet', async () => {
    // requireAppOwner: SELECT creator_id FROM apps  -> {creator_id: gh:1}
    // SELECT * FROM app_listings                   -> null
    const owner = mockStmt({ first: { creator_id: 'gh:1' } });
    const listing = mockStmt({ first: null });
    const db = mockD1(owner, listing);
    const res = await app.request('/v1/apps/meetup/listing', { headers: { Authorization: `Bearer ${TOK}` } }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appId: string; tagline: string | null; screenshots: string[] };
    expect(body.appId).toBe('meetup');
    expect(body.tagline).toBeNull();
    expect(body.screenshots).toEqual([]);
  });

  it('404s when the app is not owned by the user', async () => {
    // requireAppOwner: SELECT returns null
    const owner = mockStmt({ first: null });
    const db = mockD1(owner);
    const res = await app.request('/v1/apps/somebody-elses/listing', { headers: { Authorization: `Bearer ${TOK}` } }, makeEnv(db));
    expect(res.status).toBe(404);
  });
});

describe('PUT /v1/apps/:id/listing validation', () => {
  it('rejects overlong tagline (regression: previously silently truncated)', async () => {
    const owner = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(owner);
    const res = await app.request(
      '/v1/apps/meetup/listing',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagline: 'x'.repeat(65) }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/tagline too long/i);
    expect(text).toMatch(/60/);
  });

  it('rejects overlong longDescription', async () => {
    const owner = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(owner);
    const res = await app.request(
      '/v1/apps/meetup/listing',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ longDescription: 'x'.repeat(5001) }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/longDescription too long/i);
  });

  it('rejects bogus theme color with a helpful message', async () => {
    const owner = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(owner);
    const res = await app.request(
      '/v1/apps/meetup/listing',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ themeColor: 'not-a-color' }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/invalid color/i);
    // Regression: error must accept #RGB and #RRGGBBAA, not just #RRGGBB
    expect(text).toMatch(/#RRGGBBAA/);
  });

  it('rejects javascript: URLs in any URL field', async () => {
    const owner = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(owner);
    const res = await app.request(
      '/v1/apps/meetup/listing',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteUrl: 'javascript:alert(1)' }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/invalid URL/i);
  });

  it('does not touch terms_url when only snake_case is sent (regression: previously nulled termsUrl)', async () => {
    // requireAppOwner ok, no DB writes expected because no recognised fields
    const owner = mockStmt({ first: { creator_id: 'gh:1' } });
    // empty-patch path: INSERT bumping updated_at only
    const upsert = mockStmt();
    // then re-read
    const reread = mockStmt({ first: null });
    const db = mockD1(owner, upsert, reread);

    const res = await app.request(
      '/v1/apps/meetup/listing',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms_url: 'https://example.com/terms' }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);

    // The upsert SQL must NOT include `terms_url` in its column list,
    // because snake_case input was previously a destructive alias that
    // wrote `null` to termsUrl. The fix removed the alias.
    const sqls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls.map((args) => args[0] as string);
    const writes = sqls.filter((s) => s.startsWith('INSERT') || s.startsWith('UPDATE'));
    for (const w of writes) {
      expect(w).not.toMatch(/terms_url\s*,/);
      expect(w).not.toMatch(/terms_url\s*=/);
    }
  });

  it('accepts a valid hex color and writes through to D1', async () => {
    const owner = mockStmt({ first: { creator_id: 'gh:1' } });
    const upsert = mockStmt();
    const reread = mockStmt({
      first: {
        app_id: 'meetup',
        theme_color: '#7c3aed',
        screenshots_json: '[]',
        updated_at: 1,
        // null for unset fields:
        icon_url: null, splash_color: null, tagline: null, long_description: null, category: null,
        website_url: null, support_email: null, support_url: null,
        social_twitter: null, social_github: null, social_mastodon: null, social_bluesky: null,
        privacy_policy_url: null, terms_url: null,
      },
    });
    const db = mockD1(owner, upsert, reread);

    const res = await app.request(
      '/v1/apps/meetup/listing',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ themeColor: '#7c3aed' }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { themeColor: string | null };
    expect(body.themeColor).toBe('#7c3aed');
  });
});

describe('PUT /v1/apps/:id/listing-assets/:kind', () => {
  it('rejects unknown asset kinds', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request(
      '/v1/apps/meetup/listing-assets/garbage',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'image/png' },
        body: new Uint8Array([1, 2, 3]),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/invalid asset kind/i);
  });

  it('rejects mismatched content-type for markdown kinds', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request(
      '/v1/apps/meetup/listing-assets/privacy-policy',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'image/png' },
        body: new Uint8Array([1, 2, 3]),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/text\/markdown/i);
  });

  it('rejects empty bodies', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request(
      '/v1/apps/meetup/listing-assets/icon',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'image/png' },
        body: new Uint8Array([]),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/empty body/i);
  });
});
