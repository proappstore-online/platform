/**
 * Living Knowledge Base → RAG grounding for the build agents.
 *
 * The KB (KNOWLEDGE.md + docs/*.md) grows over a project's life — the Architect
 * writes it, humans add to it. Dumping the WHOLE thing into every build-agent
 * turn (the old `files.get('KNOWLEDGE.md')` path) doesn't scale: cost grows with
 * the KB, it overflows context, and it feeds irrelevant sections.
 *
 * Instead: chunk + embed each KB file into Vectorize on write (per-project,
 * isolated by slug), then for each ticket retrieve only the semantically
 * relevant chunks and inject those + the concise overview. Workers AI provides
 * the embeddings (`@cf/baai/bge-base-en-v1.5`) — the same pattern PAGS uses.
 *
 * Degrades gracefully: with no AI/VECTORIZE binding, retrieve() returns [] and
 * the caller falls back to whole-file injection, so this is safe + additive.
 */

import type { Ai, VectorizeIndex } from '@cloudflare/workers-types';

export const KB_EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
/** ~1.2k chars ≈ a few paragraphs — small enough to retrieve precisely, big
 *  enough to keep a self-contained idea. */
export const KB_MAX_CHUNK_CHARS = 1200;
/** A path is part of the KB if it's the root overview or a markdown doc. */
export function isKbPath(path: string): boolean {
  return path === 'KNOWLEDGE.md' || /^docs\/.+\.(md|markdown)$/i.test(path);
}

export interface KbChunk {
  ord: number;
  /** Nearest preceding heading — keeps each chunk self-describing for retrieval. */
  heading: string;
  text: string;
}

/**
 * Split markdown into retrieval chunks: break on headings, attach each section's
 * nearest heading, then size-split long sections on paragraph boundaries. Pure.
 */
export function chunkKb(content: string, maxChars = KB_MAX_CHUNK_CHARS): KbChunk[] {
  const lines = content.split('\n');
  const sections: { heading: string; body: string[] }[] = [];
  let cur: { heading: string; body: string[] } = { heading: '', body: [] };
  let inFence = false;
  for (const line of lines) {
    // Track fenced code blocks so `#` lines INSIDE them (bash comments, embedded
    // markdown examples, etc.) aren't mistaken for headings and mis-split.
    const t = line.trimStart();
    if (t.startsWith('```') || t.startsWith('~~~')) inFence = !inFence;
    const h = !inFence ? /^#{1,6}\s+(.*)$/.exec(line) : null;
    if (h) {
      if (cur.heading || cur.body.some((l) => l.trim())) sections.push(cur);
      cur = { heading: h[1]!.trim(), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.heading || cur.body.some((l) => l.trim())) sections.push(cur);

  const chunks: KbChunk[] = [];
  let ord = 0;
  for (const sec of sections) {
    const body = sec.body.join('\n').trim();
    const full = sec.heading ? `## ${sec.heading}\n${body}`.trim() : body;
    if (!full) continue;
    if (full.length <= maxChars) {
      chunks.push({ ord: ord++, heading: sec.heading, text: full });
      continue;
    }
    // Section too long — split on blank lines (paragraphs), packing up to maxChars.
    const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let buf = sec.heading ? `## ${sec.heading}` : '';
    for (const p of paras) {
      if (buf && buf.length + p.length + 2 > maxChars) {
        chunks.push({ ord: ord++, heading: sec.heading, text: buf.trim() });
        buf = sec.heading ? `## ${sec.heading} (cont.)\n${p}` : p;
      } else {
        buf = buf ? `${buf}\n\n${p}` : p;
      }
    }
    if (buf.trim()) chunks.push({ ord: ord++, heading: sec.heading, text: buf.trim() });
  }
  return chunks;
}

export interface KbRetrieval {
  path: string;
  heading: string;
  text: string;
  score: number;
}

/**
 * Assemble the KB grounding block injected into a build agent: the concise
 * overview (always — it's the map) + the retrieved relevant chunks (cited by
 * file + heading so the agent can ask for more). Pure. Returns '' when there's
 * nothing, so the caller can omit the section entirely.
 */
export function buildKbContext(overview: string, retrieved: KbRetrieval[]): string {
  const parts: string[] = [];
  const ov = overview.trim();
  if (ov) parts.push(ov.length > 4000 ? `${ov.slice(0, 4000)}\n…(overview truncated — ask for specifics)` : ov);
  if (retrieved.length) {
    const blocks = retrieved
      .map((r) => `### From ${r.path}${r.heading ? ` › ${r.heading}` : ''}\n${r.text}`)
      .join('\n\n');
    parts.push(`## Relevant knowledge for this ticket\n${blocks}`);
  }
  return parts.join('\n\n').trim();
}

/** Hard cap on chunks indexed per KB file. Bounds re-index delete cost and keeps
 *  a single runaway doc from dominating retrieval. 64 × ~1.2k ≈ 75KB of markdown. */
export const KB_MAX_CHUNKS_PER_FILE = 64;

/** Deterministic, ≤64-byte Vectorize id for a (slug, path, ord) chunk. */
export async function kbChunkId(slug: string, path: string, ord: number): Promise<string> {
  const data = new TextEncoder().encode(`${slug}::${path}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}:${ord}`;
}

/**
 * Per-project KB vector index over a single shared Vectorize index, isolated by
 * `slug` metadata. Chunk ids are deterministic (`kbChunkId`), so a re-index
 * deletes the file's prior chunk-id RANGE (no id tracking / no extra table) then
 * upserts the fresh set — old chunks beyond the new count can't linger.
 */
export class KbIndex {
  constructor(
    private readonly ai: Ai,
    private readonly vectorize: VectorizeIndex,
    private readonly slug: string,
  ) {}

  async embed(text: string): Promise<number[] | null> {
    try {
      const res = (await this.ai.run(KB_EMBED_MODEL, { text: [text] })) as { data?: number[][] };
      return res.data?.[0] ?? null;
    } catch {
      return null;
    }
  }

  private async idRange(path: string): Promise<string[]> {
    return Promise.all(Array.from({ length: KB_MAX_CHUNKS_PER_FILE }, (_, i) => kbChunkId(this.slug, path, i)));
  }

  /** Re-index one KB file: drop its prior chunk range, embed + upsert the new
   *  chunks. Returns how many chunks were indexed. */
  async indexFile(path: string, content: string): Promise<number> {
    await this.vectorize.deleteByIds(await this.idRange(path)).catch(() => {});
    const chunks = chunkKb(content).slice(0, KB_MAX_CHUNKS_PER_FILE);
    let n = 0;
    for (const c of chunks) {
      const embedding = await this.embed(c.text);
      if (!embedding) continue;
      const id = await kbChunkId(this.slug, path, c.ord);
      await this.vectorize.upsert([
        { id, values: embedding, metadata: { slug: this.slug, path, ord: c.ord, heading: c.heading.slice(0, 200), text: c.text.slice(0, 2000) } },
      ]);
      n++;
    }
    return n;
  }

  /** Remove a deleted KB file's chunks. */
  async deleteFile(path: string): Promise<void> {
    await this.vectorize.deleteByIds(await this.idRange(path)).catch(() => {});
  }

  /** Retrieve the most relevant KB chunks for a ticket query (this project only). */
  async retrieve(query: string, topK = 6): Promise<KbRetrieval[]> {
    const embedding = await this.embed(query);
    if (!embedding) return [];
    try {
      const res = await this.vectorize.query(embedding, { topK, filter: { slug: this.slug }, returnMetadata: 'all' });
      return (res.matches ?? [])
        // Defense-in-depth: re-check slug client-side so a missing/misconfigured
        // metadata index can never bleed another project's KB into this one.
        .filter((m) => m.metadata?.slug === this.slug)
        .map((m) => ({
          path: (m.metadata?.path as string) ?? '',
          heading: (m.metadata?.heading as string) ?? '',
          text: (m.metadata?.text as string) ?? '',
          score: m.score ?? 0,
        }));
    } catch {
      return [];
    }
  }
}
