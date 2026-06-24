import { describe, expect, it, vi } from 'vitest';
import { buildKbContext, chunkKb, isKbPath, KbIndex, kbChunkId, type KbRetrieval } from './kb-rag.ts';
import type { Ai, VectorizeIndex } from '@cloudflare/workers-types';

describe('isKbPath', () => {
  it('matches the overview and docs markdown only', () => {
    expect(isKbPath('KNOWLEDGE.md')).toBe(true);
    expect(isKbPath('docs/market.md')).toBe(true);
    expect(isKbPath('docs/research/competitors.markdown')).toBe(true);
    expect(isKbPath('src/App.tsx')).toBe(false);
    expect(isKbPath('README.md')).toBe(false);
    expect(isKbPath('docs/logo.png')).toBe(false);
  });
});

describe('chunkKb', () => {
  it('splits on headings and attaches the heading to each chunk', () => {
    const md = '# Coffee\nIntro line.\n\n## Users\nCoffee drinkers.\n\n## Features\n- rate\n- browse';
    const chunks = chunkKb(md);
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.heading)).toEqual(['Coffee', 'Users', 'Features']);
    expect(chunks[1]!.text).toContain('Coffee drinkers.');
    expect(chunks.map((c) => c.ord)).toEqual([0, 1, 2]);
  });

  it('size-splits a long section on paragraph boundaries, keeping the heading', () => {
    const para = 'x'.repeat(800);
    const md = `## Big\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkKb(md, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.heading === 'Big')).toBe(true);
    expect(chunks.every((c) => c.text.length <= 1100)).toBe(true); // ~maxChars + heading
  });

  it('handles content with no headings', () => {
    const chunks = chunkKb('just some prose without headings');
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain('just some prose');
  });

  it('does NOT treat #-lines inside fenced code blocks as headings', () => {
    const md = [
      '## Setup',
      'Run the installer:',
      '```bash',
      '# install deps   <-- a comment, not a heading',
      'pnpm install',
      '## also not a heading',
      '```',
      'Done.',
    ].join('\n');
    const chunks = chunkKb(md);
    // One section ("Setup") — the code block must not split it.
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.heading).toBe('Setup');
    expect(chunks[0]!.text).toContain('# install deps');
    expect(chunks[0]!.text).toContain('pnpm install');
  });

  it('ignores empty input', () => {
    expect(chunkKb('')).toEqual([]);
    expect(chunkKb('\n\n   \n')).toEqual([]);
  });
});

describe('buildKbContext', () => {
  const ret: KbRetrieval[] = [
    { path: 'docs/market.md', heading: 'Competitors', text: 'Kava, Beanhunter…', score: 0.8 },
    { path: 'KNOWLEDGE.md', heading: 'Data model', text: 'ratings: id, place, stars', score: 0.7 },
  ];
  it('includes the overview and cites each retrieved chunk by file + heading', () => {
    const out = buildKbContext('# Coffee\nAnonymous ratings.', ret);
    expect(out).toContain('# Coffee');
    expect(out).toContain('Relevant knowledge for this ticket');
    expect(out).toContain('### From docs/market.md › Competitors');
    expect(out).toContain('### From KNOWLEDGE.md › Data model');
  });
  it('returns just the overview when nothing was retrieved', () => {
    expect(buildKbContext('# Coffee', [])).toBe('# Coffee');
  });
  it('returns empty when there is no overview and no retrieval', () => {
    expect(buildKbContext('', [])).toBe('');
  });
  it('truncates a huge overview', () => {
    const out = buildKbContext('#'.repeat(5000), []);
    expect(out).toContain('overview truncated');
  });
});

describe('kbChunkId', () => {
  it('is deterministic per (slug,path,ord) and ≤64 bytes', async () => {
    const a = await kbChunkId('coffeerating', 'docs/market.md', 2);
    const b = await kbChunkId('coffeerating', 'docs/market.md', 2);
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
  });
  it('differs by slug, path, and ord', async () => {
    const base = await kbChunkId('coffeerating', 'KNOWLEDGE.md', 0);
    expect(await kbChunkId('other', 'KNOWLEDGE.md', 0)).not.toBe(base);
    expect(await kbChunkId('coffeerating', 'docs/x.md', 0)).not.toBe(base);
    expect(await kbChunkId('coffeerating', 'KNOWLEDGE.md', 1)).not.toBe(base);
  });
});

describe('KbIndex', () => {
  function fakes() {
    const upserts: unknown[] = [];
    const deletes: string[][] = [];
    let lastQuery: { topK?: number; filter?: unknown } | undefined;
    const ai = { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) } as unknown as Ai;
    const vectorize = {
      upsert: vi.fn(async (v: unknown[]) => { upserts.push(...v); return { count: v.length }; }),
      deleteByIds: vi.fn(async (ids: string[]) => { deletes.push(ids); return { count: ids.length }; }),
      query: vi.fn(async (_e: number[], opts: { topK?: number; filter?: unknown }) => {
        lastQuery = opts;
        return { matches: [
          { id: 'x', score: 0.9, metadata: { slug: 'coffeerating', path: 'KNOWLEDGE.md', heading: 'Users', text: 'Coffee drinkers' } },
          { id: 'leak', score: 0.5, metadata: { slug: 'other-project', path: 'KNOWLEDGE.md', text: 'should be filtered out' } },
        ] };
      }),
    } as unknown as VectorizeIndex;
    return { ai, vectorize, upserts, deletes, getQuery: () => lastQuery };
  }

  it('indexFile drops the prior chunk range then upserts the new chunks', async () => {
    const f = fakes();
    const kb = new KbIndex(f.ai, f.vectorize, 'coffeerating');
    const n = await kb.indexFile('docs/market.md', '## A\nalpha\n\n## B\nbeta');
    expect(f.deletes[0]!.length).toBe(64); // deterministic id range cleared first
    expect(n).toBe(2);
    expect(f.upserts.length).toBe(2);
  });

  it('retrieve filters by slug and maps matches', async () => {
    const f = fakes();
    const kb = new KbIndex(f.ai, f.vectorize, 'coffeerating');
    const out = await kb.retrieve('how do users rate coffee', 4);
    expect(f.getQuery()).toMatchObject({ topK: 4, filter: { slug: 'coffeerating' } });
    expect(out).toHaveLength(1); // the 'other-project' match is filtered out client-side
    expect(out[0]).toMatchObject({ path: 'KNOWLEDGE.md', heading: 'Users', text: 'Coffee drinkers', score: 0.9 });
  });

  it('retrieve returns [] when embedding fails (graceful degrade)', async () => {
    const f = fakes();
    (f.ai.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: [] });
    const kb = new KbIndex(f.ai, f.vectorize, 'coffeerating');
    expect(await kb.retrieve('x')).toEqual([]);
  });
});
