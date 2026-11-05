import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planBatches } from '../packages/runtime-tests/scripts/run-backend-batches.mjs';

// #543: the backend runtime suite runs as several processes. The batching must never drop or repeat
// a test file, and the Room / WebSocket Durable Object files must stay isolated from the rest.

const all = readdirSync(new URL('../packages/runtime-tests/test/backend/', import.meta.url)).filter((f) => f.endsWith('.test.ts')).sort();

describe('backend runtime batches (#543)', () => {
  const batches = planBatches(all);

  it('runs every test file in test/backend exactly once', () => {
    const flat = batches.flatMap((b: { files: string[] }) => b.files);
    expect(flat).toHaveLength(all.length);
    expect([...flat].sort()).toEqual(all);
  });

  it('keeps the Room / WebSocket Durable Object files together, last, and apart from everything else', () => {
    expect(batches.map((b: { name: string }) => b.name)).toEqual(['general-1', 'general-2', 'rooms']);
    expect(batches.at(-1)!.files).toEqual(['room-publish.test.ts', 'room-seq-durable.test.ts', 'rooms-do.test.ts', 'visibility.test.ts']);
    for (const b of batches.slice(0, -1)) expect(b.files.some((f: string) => /^room/.test(f) || f === 'visibility.test.ts')).toBe(false);
  });

  it('has more than one batch, none empty, so a native fault cannot take out the whole suite', () => {
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(b.files.length).toBeGreaterThan(0);
  });

  it('fails loudly if an isolated file is renamed, instead of quietly running fewer tests', () => {
    expect(() => planBatches(all.filter((f) => f !== 'rooms-do.test.ts'))).toThrow(/rooms-do\.test\.ts/);
  });

  it('is deterministic for the same files', () => {
    expect(planBatches([...all])).toEqual(batches);
  });

  it('a new test file lands in exactly one general batch', () => {
    const extra = planBatches([...all, 'zzz-new.test.ts']);
    expect(extra.flatMap((b: { files: string[] }) => b.files).filter((f: string) => f === 'zzz-new.test.ts')).toHaveLength(1);
    expect(extra.at(-1)!.files).toHaveLength(4);
  });
});
