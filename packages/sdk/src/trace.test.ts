import { describe, expect, it } from 'vitest';
import {
  createRequestContext, generateSpanId, generateTraceId, isAllowedTracePropagationTarget, makeTraceparent, parseTraceparent,
} from './trace.js';

const API = 'https://api.proappstore.online';
const DATA = 'https://data-leads.proappstore.online';

describe('W3C trace context (#390)', () => {
  it('generates lowercase hex ids of the W3C lengths', () => {
    expect(generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('round-trips a traceparent', () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    expect(parseTraceparent(makeTraceparent(traceId, spanId))).toEqual({ traceId, spanId, flags: '01' });
  });

  it.each([
    ['empty', ''],
    ['garbage', 'garbage-abc-def'],
    ['all-zero trace', `00-${'0'.repeat(32)}-${'a'.repeat(16)}-01`],
    ['all-zero span', `00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`],
    ['short trace', `00-${'a'.repeat(31)}-${'a'.repeat(16)}-01`],
    ['unknown version', `ff-${'a'.repeat(32)}-${'a'.repeat(16)}-01`],
    ['trailing data', `00-${'a'.repeat(32)}-${'a'.repeat(16)}-01-extra`],
    ['a URL', 'https://evil.example/?token=x'],
  ])('rejects a malformed traceparent (%s)', (_what, header) => {
    expect(parseTraceparent(header)).toBeNull();
  });

  it('propagates only to the platform: /.pas/ mediation, the API and this app\'s data worker', () => {
    expect(isAllowedTracePropagationTarget('/.pas/api/v1/apps/leads/actions/x', API, DATA)).toBe(true);
    expect(isAllowedTracePropagationTarget(`${API}/v1/apps/leads/actions/x`, API, DATA)).toBe(true);
    expect(isAllowedTracePropagationTarget(new URL(`${DATA}/v1/query`), API, DATA)).toBe(true);
    for (const url of ['https://hooks.example/x', 'https://data-other.proappstore.online/v1/query', 'https://api.proappstore.online.evil.example/', '/app/page', 'http://api.proappstore.online/v1', 'not a url']) {
      expect(isAllowedTracePropagationTarget(url, API, DATA), url).toBe(false);
    }
  });

  it('each context is independent', () => {
    const contexts = Array.from({ length: 50 }, () => createRequestContext('action.x'));
    expect(new Set(contexts.map((c) => c.traceId)).size).toBe(50);
    expect(new Set(contexts.map((c) => c.spanId)).size).toBe(50);
    expect(contexts[0]).toMatchObject({ operation: 'action.x', startedAt: expect.any(Number) });
  });
});
