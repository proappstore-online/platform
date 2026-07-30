import { describe, expect, it } from 'vitest';
import {
  BURST_ENTRIES_PER_SECOND,
  MAX_BATCH_SIZE,
  MAX_ENTRY_SIZE,
  fingerprintEntry,
  messageShape,
  normalizeBatch,
  normalizeClientId,
  normalizeEntry,
  traceIdFromTraceparent,
} from './log-ingest.js';

const NOW = 1_800_000_000_000;

function raw(over: Record<string, unknown> = {}) {
  return { ts: NOW, level: 'error', category: 'app', message: 'boom', ...over };
}

describe('limit invariants', () => {
  // A single legal batch must never be throttled on arrival; this ordering is
  // the bug the route tests caught when burst was below the batch cap.
  it('keeps the burst ceiling at or above one full batch', () => {
    expect(BURST_ENTRIES_PER_SECOND).toBeGreaterThanOrEqual(MAX_BATCH_SIZE);
  });
});

describe('normalizeClientId', () => {
  it('accepts plausible install ids', () => {
    expect(normalizeClientId('install-abc12345')).toBe('install-abc12345');
    expect(normalizeClientId('A'.repeat(64))).toBe('A'.repeat(64));
  });

  it('rejects malformed, oversized, and non-string ids', () => {
    expect(normalizeClientId('short')).toBeNull();
    expect(normalizeClientId('A'.repeat(65))).toBeNull();
    expect(normalizeClientId('has spaces!')).toBeNull();
    expect(normalizeClientId(42)).toBeNull();
    expect(normalizeClientId(undefined)).toBeNull();
  });
});

describe('traceIdFromTraceparent', () => {
  it('extracts the trace-id from a W3C traceparent', () => {
    expect(traceIdFromTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')).toBe(
      '0af7651916cd43dd8448eb211c80319c',
    );
  });

  it('lowercases', () => {
    expect(traceIdFromTraceparent('00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01')).toBe(
      '0af7651916cd43dd8448eb211c80319c',
    );
  });

  it('rejects malformed, all-zero, and absent headers', () => {
    expect(traceIdFromTraceparent('00-tooshort-b7ad6b7169203331-01')).toBeNull();
    // All-zero trace-id is invalid per spec — it means "no trace", not a trace.
    expect(traceIdFromTraceparent(`00-${'0'.repeat(32)}-b7ad6b7169203331-01`)).toBeNull();
    expect(traceIdFromTraceparent('garbage')).toBeNull();
    expect(traceIdFromTraceparent(null)).toBeNull();
  });
});

describe('messageShape', () => {
  it('collapses ids and numbers so one fault is one group', () => {
    expect(messageShape('load failed for user 123')).toBe(messageShape('load failed for user 987'));
  });

  it('collapses uuids, long hex, and quoted values', () => {
    expect(messageShape('app 3f8b1c2d-4e5f-6a7b-8c9d-0e1f2a3b4c5d down')).toContain('<uuid>');
    expect(messageShape(`key ${'a1b2c3d4'.repeat(3)}`)).toContain('<hex>');
    expect(messageShape('action "provisionChild" denied')).toBe('action "<s>" denied');
  });

  it('keeps genuinely different faults apart', () => {
    expect(messageShape('load failed')).not.toBe(messageShape('save failed'));
  });
});

describe('fingerprintEntry', () => {
  it('separates level and category, groups equivalent messages', async () => {
    const a = await fingerprintEntry('error', 'action', 'failed for 1');
    expect(a).toBe(await fingerprintEntry('error', 'action', 'failed for 2'));
    expect(a).not.toBe(await fingerprintEntry('warn', 'action', 'failed for 1'));
    expect(a).not.toBe(await fingerprintEntry('error', 'auth.credentials', 'failed for 1'));
  });
});

describe('normalizeEntry', () => {
  it('accepts a well-formed entry', async () => {
    const e = await normalizeEntry(raw(), NOW);
    expect(e).toMatchObject({ ts: NOW, level: 'error', category: 'app', message: 'boom' });
    expect(e!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects unknown levels rather than storing them verbatim', async () => {
    expect(await normalizeEntry(raw({ level: 'catastrophe' }), NOW)).toBeNull();
    expect(await normalizeEntry(raw({ level: undefined }), NOW)).toBeNull();
  });

  it('lowercases known levels', async () => {
    expect((await normalizeEntry(raw({ level: 'ERROR' }), NOW))!.level).toBe('error');
  });

  it('rejects empty and non-string messages', async () => {
    expect(await normalizeEntry(raw({ message: '   ' }), NOW)).toBeNull();
    expect(await normalizeEntry(raw({ message: 42 }), NOW)).toBeNull();
  });

  it('clamps a forged far-future timestamp to now', async () => {
    // Otherwise the row sorts above every real entry forever, and retention
    // (which prunes on ingested_at) can never be reasoned about from `ts`.
    const e = await normalizeEntry(raw({ ts: NOW + 10 * 365 * 24 * 3600 * 1000 }), NOW);
    expect(e!.ts).toBe(NOW);
  });

  it('clamps a missing or non-numeric timestamp to now', async () => {
    expect((await normalizeEntry(raw({ ts: undefined }), NOW))!.ts).toBe(NOW);
    expect((await normalizeEntry(raw({ ts: 'yesterday' }), NOW))!.ts).toBe(NOW);
  });

  it('keeps a plausible client clock inside the skew window', async () => {
    expect((await normalizeEntry(raw({ ts: NOW - 60_000 }), NOW))!.ts).toBe(NOW - 60_000);
  });

  it('falls back to category app for malformed categories', async () => {
    expect((await normalizeEntry(raw({ category: 'has spaces' }), NOW))!.category).toBe('app');
    expect((await normalizeEntry(raw({ category: 'x'.repeat(64) }), NOW))!.category).toBe('app');
    expect((await normalizeEntry(raw({ category: 'auth.credentials' }), NOW))!.category).toBe(
      'auth.credentials',
    );
  });

  it('scrubs secrets from the message and the data payload', async () => {
    const e = await normalizeEntry(
      raw({ message: 'failed with password=hunter2', data: { authorization: 'Bearer abc123' } }),
      NOW,
    );
    expect(e!.message).not.toContain('hunter2');
    expect(e!.data).not.toContain('abc123');
  });

  it('truncates oversized messages and payloads', async () => {
    const e = await normalizeEntry(raw({ message: 'x'.repeat(MAX_ENTRY_SIZE * 2) }), NOW);
    expect(e!.message.length).toBe(MAX_ENTRY_SIZE);
  });

  it('survives an unserializable data payload without losing the message', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const e = await normalizeEntry(raw({ data: cyclic }), NOW);
    expect(e!.data).toBeNull();
    expect(e!.message).toBe('boom');
  });

  it('rejects non-object input', async () => {
    expect(await normalizeEntry(null as never, NOW)).toBeNull();
    expect(await normalizeEntry('nope' as never, NOW)).toBeNull();
  });
});

describe('normalizeBatch', () => {
  it('drops bad entries and keeps good ones', async () => {
    const out = await normalizeBatch([raw(), raw({ level: 'nope' }), raw({ message: '' })], NOW);
    expect(out).toHaveLength(1);
  });

  it('caps at MAX_BATCH_SIZE', async () => {
    const out = await normalizeBatch(Array.from({ length: 250 }, () => raw()), NOW);
    expect(out).toHaveLength(MAX_BATCH_SIZE);
  });

  it('returns an empty array rather than throwing on an empty batch', async () => {
    expect(await normalizeBatch([], NOW)).toEqual([]);
  });
});
