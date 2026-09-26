/**
 * Content moderation on Workers AI (#213, a child of #27): Llama Guard 3 on the
 * backend's existing `[ai]` binding — no new resource, same metered usage as
 * app.ai. Used where caller-written text leaves the platform under its own name
 * (notify-user email). Callers fail closed: anything but a clear verdict is an
 * error, never an implicit "safe".
 */

export const MODERATION_MODEL = '@cf/meta/llama-guard-3-8b';
export const MODERATION_TIMEOUT_MS = 5_000;

export type ModerationResult =
  | { verdict: 'safe' }
  | { verdict: 'unsafe'; categories: string[] }
  | { verdict: 'error'; reason: string };

type AiBinding = { run(model: string, inputs: Record<string, unknown>): Promise<unknown> } | undefined;

/**
 * Read either Llama Guard output shape: the model's text (`"safe"` or
 * `"unsafe\nS1,S10"`), or the structured `{ safe, categories }`, bare or under
 * `response`. Anything else is unrecognised (null).
 */
export function parseLlamaGuard(output: unknown): { safe: boolean; categories: string[] } | null {
  const value = output && typeof output === 'object' && 'response' in output ? (output as { response: unknown }).response : output;
  if (typeof value === 'string') {
    const [first, second] = value.trim().split(/\r?\n/);
    const verdict = first?.trim().toLowerCase();
    if (verdict === 'safe') return { safe: true, categories: [] };
    if (verdict === 'unsafe') return { safe: false, categories: (second ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
    return null;
  }
  if (value && typeof value === 'object' && typeof (value as { safe?: unknown }).safe === 'boolean') {
    const { safe, categories } = value as { safe: boolean; categories?: unknown };
    return { safe, categories: Array.isArray(categories) ? categories.map(String) : [] };
  }
  return null;
}

/** One Llama Guard call over `text` as a user turn. Never throws. */
export async function moderateText(ai: AiBinding, text: string, timeoutMs = MODERATION_TIMEOUT_MS): Promise<ModerationResult> {
  if (!ai?.run) return { verdict: 'error', reason: 'Workers AI binding not configured' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      ai.run(MODERATION_MODEL, { messages: [{ role: 'user', content: text }] }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`moderation timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    const parsed = parseLlamaGuard(output);
    if (!parsed) return { verdict: 'error', reason: 'unrecognised moderation answer' };
    return parsed.safe ? { verdict: 'safe' } : { verdict: 'unsafe', categories: parsed.categories };
  } catch (err) {
    return { verdict: 'error', reason: err instanceof Error ? err.message.slice(0, 200) : 'moderation failed' };
  } finally {
    clearTimeout(timer);
  }
}
