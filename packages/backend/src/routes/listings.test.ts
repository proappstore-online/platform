import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, mockD1, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function makeEnv(db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv(
    {
      STORAGE: { put: vi.fn() } as unknown as R2Bucket,
      VAPID_PUBLIC_KEY: 'p',
      VAPID_PRIVATE_KEY: 'q',
    },
    db,
  );
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

// #214 (child of #27): owner-edited storefront copy is moderated on Workers AI
// before it is written, fail-closed, and only when the text actually changes.
describe('PUT /v1/apps/:id/listing — Workers AI moderation of tagline / longDescription (#214)', () => {
  let stored: { tagline: string | null; long_description: string | null; theme_color?: string | null } | null;
  let writes: { sql: string; args: unknown[] }[];
  let ai: { run: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    stored = { tagline: 'Plan your club', long_description: 'Schedules and scores.' };
    writes = [];
    ai = { run: vi.fn(async () => ({ response: 'safe' })) };
  });

  function db() {
    return {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes('SELECT creator_id FROM apps')) return { creator_id: 'gh:1' };
            if (sql.includes('FROM app_listings')) return stored ? { app_id: 'meetup', updated_at: 1, ...stored } : null;
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => { if (sql.includes('INSERT INTO app_listings')) writes.push({ sql, args }); return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as ReturnType<typeof mockD1>;
  }
  const put = (body: Record<string, unknown>, withAi = true) => app.request(
    '/v1/apps/meetup/listing',
    { method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    sharedMakeEnv({ STORAGE: { put: vi.fn() } as unknown as R2Bucket, VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'q', AI: withAi ? ai : undefined }, db()),
  );

  it('(a) an unsafe tagline is a 422 with categories, and nothing is written (not even the other fields)', async () => {
    ai.run.mockResolvedValue({ response: 'unsafe\nS10' });
    const res = await put({ tagline: 'Hate speech here', themeColor: '#112233' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'listing text rejected by content moderation', categories: ['S10'] });
    expect(writes).toEqual([]);
  });

  it('(b) an unsafe longDescription is a 422, and nothing is written', async () => {
    ai.run.mockResolvedValue({ response: { safe: false, categories: ['S2'] } });
    const res = await put({ longDescription: 'Buy stolen cards at …' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ categories: ['S2'] });
    expect(writes).toEqual([]);
  });

  it('(c) fails closed: a model error, a timeout-shaped rejection or a missing binding is a 503 with Retry-After 5, nothing written', async () => {
    ai.run.mockRejectedValueOnce(new Error('3040: capacity exceeded'));
    const err = await put({ tagline: 'New tagline' });
    expect(err.status).toBe(503);
    expect(err.headers.get('Retry-After')).toBe('5');
    ai.run.mockRejectedValueOnce(new Error('moderation timed out after 5000 ms'));
    expect((await put({ tagline: 'New tagline' })).status).toBe(503);
    expect((await put({ tagline: 'New tagline' }, false)).status).toBe(503);
    expect(writes).toEqual([]);
  });

  it('(d) safe edits are written, both changed fields moderated in one call, with a content-free audit line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await put({ tagline: 'Run your chess club', longDescription: 'Pairings, rounds and ratings.' });
    expect(res.status).toBe(200);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.run).toHaveBeenCalledWith('@cf/meta/llama-guard-3-8b', { messages: [{ role: 'user', content: 'Run your chess club\n\nPairings, rounds and ratings.' }] });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args).toEqual(expect.arrayContaining(['Run your chess club', 'Pairings, rounds and ratings.']));
    const audit = log.mock.calls.map((call) => String(call[0])).find((l) => l.includes('listing_moderation'))!;
    expect(JSON.parse(audit)).toEqual({ event: 'listing_moderation', app_id: 'meetup', actor: 'gh:1', changed_fields: ['tagline', 'long_description'], verdict: 'safe' });
    expect(audit).not.toContain('chess club');
    log.mockRestore();
  });

  it('(d) only the changed field is moderated when the other is resent unchanged', async () => {
    await put({ tagline: 'Plan your club', longDescription: 'A new description.' });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.run.mock.calls[0]![1]).toEqual({ messages: [{ role: 'user', content: 'A new description.' }] });
  });

  it('(e) unchanged, absent or cleared text never calls the model', async () => {
    expect((await put({ tagline: 'Plan your club', longDescription: 'Schedules and scores.' })).status).toBe(200);
    expect((await put({ tagline: '  Plan your club  ' })).status).toBe(200); // cleaned to the stored value
    expect((await put({ tagline: '' })).status).toBe(200); // clearing publishes nothing new
    expect((await put({})).status).toBe(200);
    expect(ai.run).not.toHaveBeenCalled();
    expect(writes).toHaveLength(4); // every call wrote (the empty body is the existing updated_at-only upsert)
  });

  it('(f) other fields patched alone never call the model, even with no AI binding', async () => {
    const res = await put({ themeColor: '#112233', websiteUrl: 'https://example.com' }, false);
    expect(res.status).toBe(200);
    expect(ai.run).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });

  it('a first-ever listing (no stored row) is moderated like any change', async () => {
    stored = null;
    expect((await put({ tagline: 'Brand new app' })).status).toBe(200);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });
});
