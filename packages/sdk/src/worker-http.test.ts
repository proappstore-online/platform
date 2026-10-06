import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerHttp } from './worker-http.js';

// #260: the browser reaches its app worker same-origin, with the session cookie.
afterEach(() => vi.unstubAllGlobals());

describe('pro.worker.fetch (#260)', () => {
  it('calls /.pas/worker/<path> with same-origin credentials, keeping the caller\'s init', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    await new WorkerHttp().fetch('/v1/ping');
    await new WorkerHttp().fetch('v1/rows', { method: 'POST', body: '{}' });
    expect(fetch.mock.calls).toEqual([
      ['/.pas/worker/v1/ping', { credentials: 'same-origin' }],
      ['/.pas/worker/v1/rows', { credentials: 'same-origin', method: 'POST', body: '{}' }],
    ]);
  });
});
