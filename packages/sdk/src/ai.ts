interface AuthLike {
  token: string | null;
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export type TextModelAlias = 'fast' | 'smart';
export type EmbedModelAlias = 'm3' | 'base';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  /** Model alias — 'fast' (default, Llama-3.1-8B) or 'smart' (Llama-3.3-70B). */
  model?: TextModelAlias;
  /** Cap on generated tokens. Server clamps to 1–1024. */
  maxTokens?: number;
  /** Sampling temperature. Server clamps to [0, 2]. */
  temperature?: number;
}

export interface GenerateResult {
  /** Generated text. */
  text: string;
  /** Resolved Workers AI model identifier, e.g. `@cf/meta/llama-3.1-8b-instruct`. */
  model: string;
  /** The alias used (for logging / display). */
  alias: TextModelAlias;
}

export interface EmbedOptions {
  /** Model alias — 'm3' (default, multilingual, 1024-dim) or 'base' (English, 768-dim). */
  model?: EmbedModelAlias;
}

export interface EmbedResult {
  /** One vector per input string. */
  vectors: number[][];
  /** Resolved Workers AI model identifier. */
  model: string;
  alias: EmbedModelAlias;
  /** Dimensionality of each vector (length of vectors[0]). */
  dimensions: number;
}

/**
 * Workers AI primitive — server-side LLM + embeddings, included in the
 * platform subscription quota. No per-app key management; the platform
 * pays for the inference and bills usage back via the standard
 * platform-subscription split.
 *
 * @example
 *   const { text } = await app.ai.generate('Write a haiku about yoga');
 *
 *   const result = await app.ai.chat([
 *     { role: 'system', content: 'You are a yoga instructor.' },
 *     { role: 'user', content: 'What is downward dog?' },
 *   ]);
 *
 *   const { vectors } = await app.ai.embed(['vinyasa flow', 'restorative yoga']);
 */
export class AI {
  constructor(
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** Generate text from a single prompt. */
  async generate(prompt: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
    return this.post<GenerateResult>('/v1/ai/generate', { prompt, ...opts });
  }

  /** Multi-turn chat completion. Pass system + user + assistant messages in order. */
  async chat(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    return this.post<GenerateResult>('/v1/ai/generate', { messages, ...opts });
  }

  /** Embed one or many strings. Pass a string for a single embedding, or string[] for a batch. */
  async embed(text: string | string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
    return this.post<EmbedResult>('/v1/ai/embed', { text, ...opts });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.auth.authenticatedFetch(this.apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${path} failed: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }
}
