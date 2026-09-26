import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODERATION_MODEL, moderateText, parseLlamaGuard } from './moderation.js';

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
