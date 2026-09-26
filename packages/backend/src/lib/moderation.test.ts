import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunkText, MODERATION_CHUNK_CHARS, MODERATION_CONCURRENCY, MODERATION_MAX_CHUNKS, MODERATION_MODEL, moderateChunks, moderateText, parseLlamaGuard } from './moderation.js';

// #213: portability across Llama Guard's output shapes, and every failure path
// resolving to an explicit error (callers fail closed), never to "safe".
describe('parseLlamaGuard', () => {
  it('reads the text shape, bare or under response', () => {
    expect(parseLlamaGuard('safe')).toEqual({ safe: true, categories: [] });
    expect(parseLlamaGuard({ response: ' safe\n' })).toEqual({ safe: true, categories: [] });
    expect(parseLlamaGuard({ response: 'unsafe\nS1, S10' })).toEqual({ safe: false, categories: ['S1', 'S10'] });
    expect(parseLlamaGuard('UNSAFE')).toEqual({ safe: false, categories: [] });
  });

  it('reads the structured shape, bare or under response', () => {
    expect(parseLlamaGuard({ response: { safe: false, categories: ['S2'] } })).toEqual({ safe: false, categories: ['S2'] });
    expect(parseLlamaGuard({ safe: true })).toEqual({ safe: true, categories: [] });
  });

  it('treats anything else as unrecognised, never as safe', () => {
    for (const odd of [undefined, null, '', 'probably fine', { response: 42 }, { response: { safe: 'yes' } }, []]) {
      expect(parseLlamaGuard(odd), JSON.stringify(odd)).toBeNull();
    }
  });
});

describe('moderateText', () => {
  afterEach(() => vi.useRealTimers());

  it('calls the Llama Guard model once with the text as a user turn', async () => {
    const run = vi.fn(async () => ({ response: 'safe' }));
    await expect(moderateText({ run }, 'hello')).resolves.toEqual({ verdict: 'safe' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(MODERATION_MODEL, { messages: [{ role: 'user', content: 'hello' }] });
  });

  it('returns unsafe with categories', async () => {
    await expect(moderateText({ run: async () => 'unsafe\nS3' }, 'x')).resolves.toEqual({ verdict: 'unsafe', categories: ['S3'] });
  });

  it('turns every failure into an explicit error: missing binding, throw, unrecognised answer, timeout', async () => {
    await expect(moderateText(undefined, 'x')).resolves.toMatchObject({ verdict: 'error', reason: 'Workers AI binding not configured' });
    await expect(moderateText({ run: async () => { throw new Error('boom'); } }, 'x')).resolves.toEqual({ verdict: 'error', reason: 'boom' });
    await expect(moderateText({ run: async () => ({ response: 'hmm' }) }, 'x')).resolves.toEqual({ verdict: 'error', reason: 'unrecognised moderation answer' });
    vi.useFakeTimers();
    const pending = moderateText({ run: () => new Promise(() => {}) }, 'x', 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ verdict: 'error', reason: 'moderation timed out after 1000 ms' });
  });
});

describe('chunkText / moderateChunks (#215)', () => {
  it('packs paragraphs up to the size, hard-splits an overlong one, and keeps every character of content', () => {
    const chunks = chunkText(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(90)].join('\n\n'), 64);
    expect(chunks.every((c) => c.length <= 64)).toBe(true);
    expect(chunks.join('').replace(/\n/g, '')).toBe('a'.repeat(30) + 'b'.repeat(30) + 'c'.repeat(90));
    expect(chunkText('')).toEqual([]);
  });

  it(`covers the largest listing markdown (200 KB) within ${MODERATION_MAX_CHUNKS} chunks, even in the worst packing`, () => {
    // Paragraphs just over half a chunk: packing can fit only one per chunk.
    const para = 'x'.repeat(MODERATION_CHUNK_CHARS / 2 + 1);
    const doc = Array.from({ length: Math.ceil((200 * 1024) / (para.length + 2)) }, () => para).join('\n\n');
    expect(doc.length).toBeGreaterThanOrEqual(200 * 1024 - para.length);
    expect(chunkText(doc).length).toBeLessThanOrEqual(MODERATION_MAX_CHUNKS);
  });

  it('runs at most MODERATION_CONCURRENCY calls at once and stops at the first unsafe batch', async () => {
    let inFlight = 0;
    let peak = 0;
    const run = vi.fn(async (_m: string, input: Record<string, unknown>) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const text = (input.messages as { content: string }[])[0]!.content;
      return text.startsWith('BAD') ? { response: 'unsafe\nS1' } : { response: 'safe' };
    });
    const parts = Array.from({ length: 12 }, (_, i) => (i === 5 ? 'BAD' : 'ok') + 'y'.repeat(MODERATION_CHUNK_CHARS - 10));
    const result = await moderateChunks({ run }, parts.join('\n\n'));
    expect(result).toEqual({ verdict: 'unsafe', categories: ['S1'], chunks: 12 });
    expect(peak).toBeLessThanOrEqual(MODERATION_CONCURRENCY);
    expect(run).toHaveBeenCalledTimes(8); // two batches of 4: the second holds the unsafe chunk
  });

  it('is an error, never safe, when any chunk fails or the text is too long to cover', async () => {
    const run = vi.fn(async () => { throw new Error('boom'); });
    await expect(moderateChunks({ run }, 'hello')).resolves.toEqual({ verdict: 'error', reason: 'boom', chunks: 1 });
    const huge = Array.from({ length: MODERATION_MAX_CHUNKS + 1 }, () => 'z'.repeat(MODERATION_CHUNK_CHARS)).join('\n\n');
    const tooLong = await moderateChunks({ run: vi.fn() }, huge);
    expect(tooLong.verdict).toBe('error');
    await expect(moderateChunks({ run: vi.fn() }, '')).resolves.toEqual({ verdict: 'safe', chunks: 0 });
  });
});
