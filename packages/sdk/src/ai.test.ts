import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI } from './ai.js';

interface AuthLike {
  token: string | null;
  handleUnauthorized: () => void;
}

function fakeAuth(token: string | null): AuthLike {
  return { token, handleUnauthorized: vi.fn() };
}

const BASE = 'https://api.proappstore.online';

describe('AI.generate', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs the prompt and returns the resolved result', async () => {
    const ai = new AI(BASE, fakeAuth('tok'));
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ text: 'Yoga is breath', model: '@cf/meta/llama-3.1-8b-instruct', alias: 'fast' }),
        { status: 200 },
      ),
    );

    const r = await ai.generate('Write something');

    expect(r.text).toBe('Yoga is breath');
    expect(r.alias).toBe('fast');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/ai/generate`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ prompt: 'Write something' });
  });

  it('forwards model / maxTokens / temperature options', async () => {
    const ai = new AI(BASE, fakeAuth('tok'));
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'ok', model: 'x', alias: 'smart' }), { status: 200 }),
    );
    await ai.generate('hi', { model: 'smart', maxTokens: 200, temperature: 0.3 });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ prompt: 'hi', model: 'smart', maxTokens: 200, temperature: 0.3 });
  });

  it('throws when not signed in', async () => {
    const ai = new AI(BASE, fakeAuth(null));
    await expect(ai.generate('hi')).rejects.toThrow(/Not signed in/);
  });

  it('clears session on 401 and throws', async () => {
    const auth = fakeAuth('stale');
    const ai = new AI(BASE, auth);
    mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(ai.generate('hi')).rejects.toThrow(/Not signed in/);
    expect(auth.handleUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('propagates server error text in the thrown message', async () => {
    const ai = new AI(BASE, fakeAuth('tok'));
    mockFetch.mockResolvedValueOnce(new Response('unknown model alias', { status: 400 }));
    await expect(ai.generate('hi', { model: 'bogus' as unknown as 'fast' })).rejects.toThrow(
      /400.*unknown model alias/,
    );
  });
});

describe('AI.chat', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs messages array (not prompt)', async () => {
    const ai = new AI(BASE, fakeAuth('tok'));
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'ok', model: 'x', alias: 'fast' }), { status: 200 }),
    );

    await ai.chat([
      { role: 'system', content: 'You are a yoga instructor.' },
      { role: 'user', content: 'Hi' },
    ]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a yoga instructor.' });
    expect(body.prompt).toBeUndefined();
  });
});

describe('AI.embed', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('embeds a single string', async () => {
    const ai = new AI(BASE, fakeAuth('tok'));
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ vectors: [[0.1, 0.2]], dimensions: 2, model: 'x', alias: 'm3' }),
        { status: 200 },
      ),
    );

    const r = await ai.embed('vinyasa');
    expect(r.vectors).toEqual([[0.1, 0.2]]);
    expect(r.dimensions).toBe(2);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ text: 'vinyasa' });
  });

  it('embeds a batch', async () => {
    const ai = new AI(BASE, fakeAuth('tok'));
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ vectors: [[1], [2]], dimensions: 1, model: 'x', alias: 'm3' }), {
        status: 200,
      }),
    );

    await ai.embed(['a', 'b'], { model: 'base' });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ text: ['a', 'b'], model: 'base' });
  });
});
