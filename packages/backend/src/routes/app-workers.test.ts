import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';
import { APP_CONTEXT_HEADER } from '../lib/app-context.js';
import { MAX_WORKER_OBJECT_BYTES } from '../lib/app-worker-calls.js';
import { WORKER_HTTP_MAX_REQUEST_BYTES, WORKER_HTTP_MAX_RESPONSE_BYTES } from './app-workers.js';

// #385: the worker HTTP plane takes a full-size worker document (10 MiB) plus
// multipart framing, refuses a larger body without buffering it, and only after
// the caller has been admitted. The round trip on real D1 and the Worker Loader
// is runtime-tests/test/backend/worker-http.test.ts.

const TOK = await testToken('gh:42');
const CHUNK = 256 * 1024;

/** The app `t` exists, is public, and has an enabled, deployed worker. */
function db() {
  const stmt = (sql: string) => {
    const st = {
      bind: () => st,
      first: async () => (/FROM app_workers w/.test(sql) ? { app_id: 't', enabled: 1, deployed_at: 1, bundle_sha256: 'b', token_hash: 'h' } : null),
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 1 } }),
    };
    return st;
  };
  return { prepare: (sql: string) => stmt(sql), batch: async () => [] } as unknown as D1Database;
}

/** A body of `total` bytes, counting how many were pulled. */
function stream(total: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) return controller.close();
      pulled += CHUNK;
      controller.enqueue(new Uint8Array(CHUNK));
    },
  }, { highWaterMark: 0 }); // pulled only when read, never ahead of it
  return { body, pulled: () => pulled };
}

function post(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}, token: string | null = TOK) {
  return app.request('/v1/apps/t/worker/http', {
    method: 'POST',
    body,
    duplex: 'half',
    headers: {
      [APP_CONTEXT_HEADER]: 't', 'X-PAS-Worker-Method': 'POST', 'X-PAS-Worker-Path': '/upload',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
    },
  } as RequestInit, makeEnv({ DB: db() }));
}

describe('worker HTTP size limits (#385)', () => {
  it('a request takes a full worker document plus 1 MiB of multipart framing; a response the same', () => {
    expect(MAX_WORKER_OBJECT_BYTES).toBe(10 * 1024 * 1024);
    expect(WORKER_HTTP_MAX_REQUEST_BYTES).toBe(11 * 1024 * 1024);
    expect(WORKER_HTTP_MAX_RESPONSE_BYTES).toBe(WORKER_HTTP_MAX_REQUEST_BYTES);
  });

  it('a declared Content-Length over the cap is a 413 before any of the body is read', async () => {
    const big = stream(WORKER_HTTP_MAX_REQUEST_BYTES * 2);
    const res = await post(big.body, { 'content-length': String(WORKER_HTTP_MAX_REQUEST_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(big.pulled()).toBe(0);
  });

  it('a chunked body with no Content-Length is read only to the cap, then refused', async () => {
    const big = stream(WORKER_HTTP_MAX_REQUEST_BYTES * 4);
    const res = await post(big.body);
    expect(res.status).toBe(413);
    expect(big.pulled()).toBeLessThanOrEqual(WORKER_HTTP_MAX_REQUEST_BYTES + 2 * CHUNK);
  });

  it('a signed-out or direct (not via the app origin) caller is refused before any body is read', async () => {
    const anon = stream(WORKER_HTTP_MAX_REQUEST_BYTES);
    expect((await post(anon.body, {}, null)).status).toBe(401);
    expect(anon.pulled()).toBe(0);
    const direct = stream(WORKER_HTTP_MAX_REQUEST_BYTES);
    expect((await post(direct.body, { [APP_CONTEXT_HEADER]: 'other' })).status).toBe(403);
    expect(direct.pulled()).toBe(0);
  });
});
