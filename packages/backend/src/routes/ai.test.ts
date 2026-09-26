import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

/**
 * A D1 fake for the #218 daily budget, matching the real statement's semantics:
 * insert, or increment only while the result stays within the cap (RETURNING
 * nothing when it would not). `fail` makes D1 throw.
 */
function budgetDb(opts: { fail?: boolean } = {}) {
  const used = new Map<string, number>();
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => {
        if (opts.fail) throw new Error('D1_ERROR: database unavailable');
        if (!sql.includes('INSERT INTO ai_daily_budget')) return null;
        const [userId, date, units, cap] = args as [string, string, number, number];
        const key = `${userId}|${date}`;
        const current = used.get(key);
        if (current === undefined) { used.set(key, units); return { units_used: units }; }
        if (current + units > cap) return null;
        used.set(key, current + units);
        return { units_used: current + units };
      },
    }),
  }));
  return { prepare, used } as unknown as D1Database & { prepare: typeof prepare; used: Map<string, number> };
}

/** The ratelimit binding contract: `limit` successes per key, then refusals. */
function limiter(limit: number) {
  const counts = new Map<string, number>();
  return { limit: vi.fn(async ({ key }: { key: string }) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { success: n <= limit };
  }) };
}

function makeEnv(aiRun?: (model: string, inputs: Record<string, unknown>) => Promise<unknown>, overrides: Record<string, unknown> = {}) {
  return sharedMakeEnv({
    DB: budgetDb(),
    STRIPE_SECRET_KEY: 'sk',
    STRIPE_WEBHOOK_SECRET: 'whsec',
    CF_API_TOKEN: 'tok',
    CF_ACCOUNT_ID: 'acct',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    AI: {
      run: aiRun ?? (async () => ({ response: 'default mock response' })),
    },
    ...overrides,
  });
}

describe('GET /v1/ai/models', () => {
  it('lists allowed text + embed model aliases (no auth required for discovery)', async () => {
    const res = await app.request('/v1/ai/models', {}, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      text: { alias: string; model: string }[];
      embed: { alias: string; model: string }[];
    };
    expect(body.text.map((m) => m.alias).sort()).toEqual(['fast', 'smart']);
    expect(body.embed.map((m) => m.alias).sort()).toEqual(['base', 'm3']);
    expect(body.text.find((m) => m.alias === 'fast')!.model).toMatch(/llama-3\.1-8b/);
  });
});

describe('POST /v1/ai/generate', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request(
      '/v1/ai/generate',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when both prompt and messages are omitted', async () => {
    const res = await app.request(
      '/v1/ai/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('one of `prompt` or `messages`');
  });

  it('returns 400 when both prompt and messages are present', async () => {
    const res = await app.request(
      '/v1/ai/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', messages: [{ role: 'user', content: 'hi' }] }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('rejects unknown model aliases', async () => {
    const res = await app.request(
      '/v1/ai/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', model: 'definitely-not-a-model' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('unknown model alias');
  });

  it('rejects oversized prompts', async () => {
    const res = await app.request(
      '/v1/ai/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'x'.repeat(20_000) }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('too long');
  });

  it('forwards a prompt to Workers AI and returns text + resolved model', async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: 'A haiku about yoga' });
    const res = await app.request(
      '/v1/ai/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Write a haiku about yoga' }),
      },
      makeEnv(aiRun),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; model: string; alias: string };
    expect(body.text).toBe('A haiku about yoga');
    expect(body.model).toMatch(/llama-3\.1-8b/);
    expect(body.alias).toBe('fast');

    expect(aiRun).toHaveBeenCalledWith(
      '@cf/meta/llama-3.1-8b-instruct',
      expect.objectContaining({ prompt: 'Write a haiku about yoga' }),
    );
  });

  it('routes the "smart" alias to the 70B model', async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: 'ok' });
    await app.request(
      '/v1/ai/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', model: 'smart' }),
      },
      makeEnv(aiRun),
    );
    expect(aiRun).toHaveBeenCalledWith(
      '@cf/meta/llama-3.3-70b-instruct',
      expect.any(Object),
    );
  });

  it('forwards messages for chat', async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: 'Downward dog is...' });
    await app.request(
      '/v1/ai/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'You are a yoga teacher.' },
            { role: 'user', content: 'What is downward dog?' },
          ],
        }),
      },
      makeEnv(aiRun),
    );
    expect(aiRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ role: 'system' })]),
      }),
    );
  });

  it('rejects messages with invalid role', async () => {
    const res = await app.request(
      '/v1/ai/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'evil', content: 'hi' }] }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid message role');
  });

  it('clamps maxTokens to [1, 1024]', async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: 'ok' });
    await app.request(
      '/v1/ai/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', maxTokens: 99_999 }),
      },
      makeEnv(aiRun),
    );
    expect(aiRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ max_tokens: 1024 }),
    );
  });

  it('returns structured error when Workers AI errors', async () => {
    const aiRun = vi.fn().mockRejectedValue(new Error('AI model unavailable'));
    const res = await app.request(
      '/v1/ai/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      },
      makeEnv(aiRun),
    );
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('model_unavailable');
    expect(body.message).toContain('AI model unavailable');
  });
});

describe('POST /v1/ai/embed', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request(
      '/v1/ai/embed',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('embeds a single string', async () => {
    const vector = Array.from({ length: 1024 }, (_, i) => i / 1024);
    const aiRun = vi.fn().mockResolvedValue({ data: [vector] });
    const res = await app.request(
      '/v1/ai/embed',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'vinyasa flow' }),
      },
      makeEnv(aiRun),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vectors: number[][]; dimensions: number; model: string };
    expect(body.vectors).toHaveLength(1);
    expect(body.dimensions).toBe(1024);
    expect(body.model).toMatch(/bge-m3/);
    expect(aiRun).toHaveBeenCalledWith(
      '@cf/baai/bge-m3',
      expect.objectContaining({ text: ['vinyasa flow'] }),
    );
  });

  it('embeds a batch of strings', async () => {
    const aiRun = vi.fn().mockResolvedValue({ data: [[1, 2], [3, 4], [5, 6]] });
    const res = await app.request(
      '/v1/ai/embed',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ['a', 'b', 'c'] }),
      },
      makeEnv(aiRun),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vectors: number[][]; dimensions: number };
    expect(body.vectors).toEqual([[1, 2], [3, 4], [5, 6]]);
    expect(body.dimensions).toBe(2);
  });

  it('rejects empty input', async () => {
    const res = await app.request(
      '/v1/ai/embed',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: [] }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('rejects batches over 100 items', async () => {
    const res = await app.request(
      '/v1/ai/embed',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: Array.from({ length: 101 }, (_, i) => `item ${i}`) }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('batch too large');
  });

  it('routes the "base" alias to the English model', async () => {
    const aiRun = vi.fn().mockResolvedValue({ data: [[0.1]] });
    await app.request(
      '/v1/ai/embed',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi', model: 'base' }),
      },
      makeEnv(aiRun),
    );
    expect(aiRun).toHaveBeenCalledWith('@cf/baai/bge-base-en-v1.5', expect.any(Object));
  });
});

// #218 (child of #27): Workers AI spend bounds on /v1/ai/*.
describe('Workers AI spend bounds (#218)', () => {
  const generate = (body: Record<string, unknown>, env: ReturnType<typeof makeEnv>, token = TOK) => app.request(
    '/v1/ai/generate',
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
  const embed = (items: number, env: ReturnType<typeof makeEnv>) => app.request(
    '/v1/ai/embed',
    { method: 'POST', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: Array.from({ length: items }, (_, i) => `t${i}`) }) },
    env,
  );
  afterEach(() => vi.useRealTimers());

  it('per-minute: the 20th call passes, the 21st is 429 with Retry-After 60 and never reaches the model', async () => {
    const run = vi.fn(async () => ({ response: 'ok' }));
    const env = makeEnv(run, { AI_RATE_LIMIT: limiter(20) });
    for (let i = 0; i < 20; i++) expect((await generate({ prompt: 'hi' }, env)).status).toBe(200);
    const over = await generate({ prompt: 'hi' }, env);
    expect(over.status).toBe(429);
    expect(over.headers.get('Retry-After')).toBe('60');
    expect(await over.json()).toMatchObject({ error: 'rate_limited' });
    expect(run).toHaveBeenCalledTimes(20);
  });

  it('per-minute limit is keyed per user', async () => {
    const env = makeEnv(undefined, { AI_RATE_LIMIT: limiter(1) });
    expect((await generate({ prompt: 'a' }, env)).status).toBe(200);
    expect((await generate({ prompt: 'a' }, env)).status).toBe(429);
    expect((await generate({ prompt: 'a' }, env, await testToken('gh:2'))).status).toBe(200);
  });

  it('daily budget applies the weights: smart = 5, fast = 1, embed = 1 per 10 items (min 1)', async () => {
    const env = makeEnv();
    const db = env.DB as unknown as { used: Map<string, number> };
    const today = new Date().toISOString().slice(0, 10);
    await generate({ prompt: 'x', model: 'smart' }, env);
    expect(db.used.get(`gh:1|${today}`)).toBe(5);
    await generate({ prompt: 'x', model: 'fast' }, env);
    expect(db.used.get(`gh:1|${today}`)).toBe(6);
    await embed(1, env);
    expect(db.used.get(`gh:1|${today}`)).toBe(7);
    await embed(25, env);
    expect(db.used.get(`gh:1|${today}`)).toBe(10);
  });

  it('over the daily budget → 429 quota_exceeded with Retry-After until UTC midnight, and the model is not called', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T23:00:00Z'));
    const run = vi.fn(async () => ({ response: 'ok' }));
    const env = makeEnv(run);
    for (let i = 0; i < 40; i++) expect((await generate({ prompt: 'x', model: 'smart' }, env)).status).toBe(200); // 200 units
    const over = await generate({ prompt: 'x', model: 'fast' }, env);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: 'quota_exceeded' });
    expect(over.headers.get('Retry-After')).toBe('3600');
    expect(run).toHaveBeenCalledTimes(40);
  });

  it('a new UTC day resets the budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T23:59:00Z'));
    const env = makeEnv();
    for (let i = 0; i < 40; i++) await generate({ prompt: 'x', model: 'smart' }, env);
    expect((await generate({ prompt: 'x' }, env)).status).toBe(429);
    vi.setSystemTime(new Date('2026-09-27T00:00:30Z'));
    expect((await generate({ prompt: 'x' }, env)).status).toBe(200);
  });

  it('fails closed with 503 when D1 is unavailable, and never calls the model', async () => {
    const run = vi.fn(async () => ({ response: 'ok' }));
    const res = await generate({ prompt: 'x' }, makeEnv(run, { DB: budgetDb({ fail: true }) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'budget_unavailable' });
    expect(run).not.toHaveBeenCalled();
  });

  it('fails open without the AI_RATE_LIMIT binding (the daily budget still applies)', async () => {
    const env = makeEnv(undefined, { AI_RATE_LIMIT: undefined });
    expect((await generate({ prompt: 'x' }, env)).status).toBe(200);
  });

  it('invalid requests are refused before any limit or charge', async () => {
    const rate = limiter(20);
    const env = makeEnv(undefined, { AI_RATE_LIMIT: rate });
    expect((await generate({}, env)).status).toBe(400);
    expect((await generate({ prompt: 'x', model: 'giant' }, env)).status).toBe(400);
    expect(rate.limit).not.toHaveBeenCalled();
    expect((env.DB as unknown as { used: Map<string, number> }).used.size).toBe(0);
  });

  it('unaffected routes: model discovery never touches the limiter or the budget', async () => {
    const rate = limiter(0);
    const env = makeEnv(undefined, { AI_RATE_LIMIT: rate });
    expect((await app.request('/v1/ai/models', {}, env)).status).toBe(200);
    expect((await app.request('/v1/pricing', {}, env)).status).toBe(200);
    expect(rate.limit).not.toHaveBeenCalled();
  });
});
