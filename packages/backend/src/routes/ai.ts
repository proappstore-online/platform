import { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

export const aiRoutes = new Hono<{ Bindings: Env }>();

/**
 * Allowlist of Workers AI models exposed to apps via app.ai.*
 *
 * Keeping this server-side means apps can't ask for arbitrary models
 * (which could be expensive or unsuited to the task) and we can rotate
 * the default without breaking callers.
 */
const TEXT_MODELS = {
  // Default — fast, free-quota-eligible, good for short generations.
  'fast': '@cf/meta/llama-3.1-8b-instruct',
  // Slower, smarter — for longer responses or harder reasoning.
  'smart': '@cf/meta/llama-3.3-70b-instruct',
} as const;
type TextModelAlias = keyof typeof TEXT_MODELS;

const EMBED_MODELS = {
  // Multilingual, 1024-dim, recommended default.
  'm3': '@cf/baai/bge-m3',
  // English-only, 768-dim — lighter when you don't need multilingual.
  'base': '@cf/baai/bge-base-en-v1.5',
} as const;
type EmbedModelAlias = keyof typeof EMBED_MODELS;

const MAX_PROMPT_CHARS = 16_000;
const MAX_BATCH_ITEMS = 100;
const MAX_MAX_TOKENS = 1024;

interface GenerateRequest {
  prompt?: string;
  messages?: { role: 'system' | 'user' | 'assistant'; content: string }[];
  model?: TextModelAlias;
  maxTokens?: number;
  temperature?: number;
}

interface EmbedRequest {
  text: string | string[];
  model?: EmbedModelAlias;
}

aiRoutes.post('/ai/generate', async (c) => {
  try {
    await requireUser(c);

    const body = await c.req.json<GenerateRequest>().catch(() => null);
    if (!body) return c.text('invalid JSON body', 400);

    const hasPrompt = typeof body.prompt === 'string' && body.prompt.length > 0;
    const hasMessages = Array.isArray(body.messages) && body.messages.length > 0;
    if (!hasPrompt && !hasMessages) {
      return c.text('one of `prompt` or `messages` is required', 400);
    }
    if (hasPrompt && hasMessages) {
      return c.text('pass only one of `prompt` or `messages`', 400);
    }

    const alias = body.model ?? 'fast';
    const model = TEXT_MODELS[alias];
    if (!model) {
      return c.text(`unknown model alias: ${alias}. Allowed: ${Object.keys(TEXT_MODELS).join(', ')}`, 400);
    }

    const inputs: Record<string, unknown> = {};
    if (hasPrompt) {
      if (body.prompt!.length > MAX_PROMPT_CHARS) {
        return c.text(`prompt too long (max ${MAX_PROMPT_CHARS} chars)`, 400);
      }
      inputs.prompt = body.prompt;
    } else {
      for (const m of body.messages!) {
        if (!['system', 'user', 'assistant'].includes(m.role)) {
          return c.text(`invalid message role: ${m.role}`, 400);
        }
        if (typeof m.content !== 'string') {
          return c.text('message.content must be a string', 400);
        }
      }
      const totalLen = body.messages!.reduce((n, m) => n + m.content.length, 0);
      if (totalLen > MAX_PROMPT_CHARS) {
        return c.text(`messages total too long (max ${MAX_PROMPT_CHARS} chars combined)`, 400);
      }
      inputs.messages = body.messages;
    }

    if (typeof body.maxTokens === 'number') {
      const n = Math.min(Math.max(Math.floor(body.maxTokens), 1), MAX_MAX_TOKENS);
      inputs.max_tokens = n;
    }
    if (typeof body.temperature === 'number') {
      // Clamp [0, 2] — Workers AI rejects values outside this anyway.
      inputs.temperature = Math.min(Math.max(body.temperature, 0), 2);
    }

    const result = (await c.env.AI.run(model, inputs)) as { response?: string } | string;
    const text = typeof result === 'string' ? result : (result.response ?? '');

    return c.json({ text, model, alias });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    const msg = err instanceof Error ? err.message : 'unknown error';
    return c.text(`ai.generate failed: ${msg}`, 500);
  }
});

aiRoutes.post('/ai/embed', async (c) => {
  try {
    await requireUser(c);

    const body = await c.req.json<EmbedRequest>().catch(() => null);
    if (!body) return c.text('invalid JSON body', 400);

    const texts = Array.isArray(body.text) ? body.text : body.text ? [body.text] : [];
    if (texts.length === 0) {
      return c.text('`text` must be a non-empty string or string[]', 400);
    }
    if (texts.length > MAX_BATCH_ITEMS) {
      return c.text(`batch too large (max ${MAX_BATCH_ITEMS} items)`, 400);
    }
    for (const t of texts) {
      if (typeof t !== 'string') return c.text('every text item must be a string', 400);
      if (t.length > MAX_PROMPT_CHARS) {
        return c.text(`text item too long (max ${MAX_PROMPT_CHARS} chars)`, 400);
      }
    }

    const alias = body.model ?? 'm3';
    const model = EMBED_MODELS[alias];
    if (!model) {
      return c.text(`unknown model alias: ${alias}. Allowed: ${Object.keys(EMBED_MODELS).join(', ')}`, 400);
    }

    const result = (await c.env.AI.run(model, { text: texts })) as
      | { data?: number[][]; shape?: number[] }
      | number[][];
    const vectors = Array.isArray(result) ? result : (result.data ?? []);

    return c.json({
      vectors,
      model,
      alias,
      dimensions: vectors[0]?.length ?? 0,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    const msg = err instanceof Error ? err.message : 'unknown error';
    return c.text(`ai.embed failed: ${msg}`, 500);
  }
});

/** List the allowed model aliases — useful for SDK discovery / docs. */
aiRoutes.get('/ai/models', (c) => {
  return c.json({
    text: Object.entries(TEXT_MODELS).map(([alias, model]) => ({ alias, model })),
    embed: Object.entries(EMBED_MODELS).map(([alias, model]) => ({ alias, model })),
  });
});
