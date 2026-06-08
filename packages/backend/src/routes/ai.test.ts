import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function makeEnv(aiRun?: (model: string, inputs: Record<string, unknown>) => Promise<unknown>) {
  return {
    DB: { prepare: vi.fn() } as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk',
    STRIPE_WEBHOOK_SECRET: 'whsec',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'tok',
    CF_ACCOUNT_ID: 'acct',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    AI: {
      run: aiRun ?? (async () => ({ response: 'default mock response' })),
    },
  };
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
