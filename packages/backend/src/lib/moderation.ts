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

/**
 * One structured audit line per moderation decision: the event, its context
 * (who, where, which fields), the verdict and the categories or error reason.
 * Never the moderated text itself.
 */
export function auditModeration(event: string, context: Record<string, unknown>, result: ModerationResult): void {
  console.log(JSON.stringify({
    event, ...context, verdict: result.verdict,
    ...(result.verdict === 'unsafe' && { categories: result.categories }),
    ...(result.verdict === 'error' && { reason: result.reason }),
  }));
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

export const MODERATION_CHUNK_CHARS = 8_000;
// Covers the largest listing markdown (MAX_MD, 200 KB): paragraph packing closes
// a chunk only when the next piece would overflow it, so any two consecutive
// chunks exceed MODERATION_CHUNK_CHARS and a 200 KB text needs at most ~53.
export const MODERATION_MAX_CHUNKS = 64;
export const MODERATION_CONCURRENCY = 4;

/**
 * Split long text into chunks of at most `size` characters, at paragraph
 * boundaries where possible (a paragraph longer than `size` is hard-split).
 */
export function chunkText(text: string, size = MODERATION_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    const pieces = paragraph.length > size ? paragraph.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [] : [paragraph];
    for (const piece of pieces) {
      if (current && current.length + 2 + piece.length > size) {
        chunks.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/**
 * Moderate long text (#215) in bounded calls: chunks of MODERATION_CHUNK_CHARS,
 * at most MODERATION_MAX_CHUNKS, MODERATION_CONCURRENCY in flight, stopping at
 * the first unsafe or error. Unsafe if any chunk is (categories combined), error
 * if any call fails or the text is too long to cover — never an implicit safe.
 */
export async function moderateChunks(ai: AiBinding, text: string, timeoutMs = MODERATION_TIMEOUT_MS): Promise<ModerationResult & { chunks: number }> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return { verdict: 'safe', chunks: 0 };
  if (chunks.length > MODERATION_MAX_CHUNKS) {
    return { verdict: 'error', reason: `text too long to moderate (${chunks.length} chunks, max ${MODERATION_MAX_CHUNKS})`, chunks: chunks.length };
  }
  const categories = new Set<string>();
  let unsafe = false;
  for (let i = 0; i < chunks.length; i += MODERATION_CONCURRENCY) {
    const batch = await Promise.all(chunks.slice(i, i + MODERATION_CONCURRENCY).map((chunk) => moderateText(ai, chunk, timeoutMs)));
    const failed = batch.find((r) => r.verdict === 'error');
    if (failed && failed.verdict === 'error') return { verdict: 'error', reason: failed.reason, chunks: chunks.length };
    for (const r of batch) {
      if (r.verdict === 'unsafe') { unsafe = true; r.categories.forEach((c) => categories.add(c)); }
    }
    if (unsafe) break;
  }
  return unsafe ? { verdict: 'unsafe', categories: [...categories], chunks: chunks.length } : { verdict: 'safe', chunks: chunks.length };
}
