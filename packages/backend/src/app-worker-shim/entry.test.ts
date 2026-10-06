import { describe, expect, it, vi } from 'vitest';
import { createShim } from './entry.js';
import { MAX_SKEW_SECONDS, SIGNATURE_HEADER, parseSignatureHeader, signatureHeader, verifySignature } from './signature.js';

// #253 / ADR-009 §1 + §3: the entry shim verifies the envelope signature before
// it imports the app module. "The app's top-level code did not run" is the
// loader spy never being called: the real shim reaches `app.js` only through it.

const KEY = 'k'.repeat(64);
const NOW_MS = 1_800_000_000_000;
const body = JSON.stringify({ v: 1, id: 'e1', app_id: 'demo', type: 'schedule', name: 'sync', attempt: 1 });

function harness() {
  const appFetch = vi.fn(async (req: Request) => new Response(`app saw ${await req.text()}`));
  const loadApp = vi.fn(async () => ({ default: { fetch: appFetch } }));
  return { shim: createShim(loadApp, () => NOW_MS), loadApp, appFetch };
}

const post = (header: string | null, payload = body) =>
  new Request('https://w/', { method: 'POST', headers: header ? { [SIGNATURE_HEADER]: header } : {}, body: payload });

describe('app-worker entry shim (#253)', () => {
  it('refuses an unsigned request with 401 and never loads the app module', async () => {
    const { shim, loadApp } = harness();
    const res = await shim.fetch(post(null), { PAS_EVENT_KEY: KEY }, {});
    expect(res.status).toBe(401);
    expect(loadApp).not.toHaveBeenCalled();
  });

  it('accepts a valid signature and hands the app the unchanged body', async () => {
    const { shim, loadApp, appFetch } = harness();
    const res = await shim.fetch(post(await signatureHeader(body, [KEY], NOW_MS / 1000)), { PAS_EVENT_KEY: KEY }, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`app saw ${body}`);
    expect(loadApp).toHaveBeenCalledTimes(1);
    expect(appFetch).toHaveBeenCalledTimes(1);
  });

  it(`refuses a signature more than ${MAX_SKEW_SECONDS} s old or ahead`, async () => {
    const { shim, loadApp } = harness();
    for (const skew of [-(MAX_SKEW_SECONDS + 1), MAX_SKEW_SECONDS + 1]) {
      const res = await shim.fetch(post(await signatureHeader(body, [KEY], NOW_MS / 1000 + skew)), { PAS_EVENT_KEY: KEY }, {});
      expect(res.status).toBe(401);
    }
    const edge = await shim.fetch(post(await signatureHeader(body, [KEY], NOW_MS / 1000 - MAX_SKEW_SECONDS)), { PAS_EVENT_KEY: KEY }, {});
    expect(edge.status).toBe(200);
    expect(loadApp).toHaveBeenCalledTimes(1);
  });

  it('accepts a header whose first v1 is wrong and a later one right (key rotation)', async () => {
    const { shim } = harness();
    const header = await signatureHeader(body, ['old-key-not-held-by-worker', KEY], NOW_MS / 1000);
    expect(header.split(',').filter((p) => p.startsWith('v1='))).toHaveLength(2);
    const res = await shim.fetch(post(header), { PAS_EVENT_KEY: KEY }, {});
    expect(res.status).toBe(200);
  });

  it('refuses a signature under the wrong key, a tampered body, and a worker with no key', async () => {
    const { shim, loadApp } = harness();
    const wrongKey = await signatureHeader(body, ['another-apps-key'], NOW_MS / 1000);
    expect((await shim.fetch(post(wrongKey), { PAS_EVENT_KEY: KEY }, {})).status).toBe(401);
    const signed = await signatureHeader(body, [KEY], NOW_MS / 1000);
    expect((await shim.fetch(post(signed, body.replace('sync', 'drop')), { PAS_EVENT_KEY: KEY }, {})).status).toBe(401);
    expect((await shim.fetch(post(signed), {}, {})).status).toBe(401);
    expect(loadApp).not.toHaveBeenCalled();
  });

  it('refuses anything but POST before reading a body', async () => {
    const { shim, loadApp } = harness();
    expect((await shim.fetch(new Request('https://w/'), { PAS_EVENT_KEY: KEY }, {})).status).toBe(405);
    expect(loadApp).not.toHaveBeenCalled();
  });
});

describe('signature header parsing', () => {
  it('rejects malformed headers rather than guessing', () => {
    for (const h of ['', 't=1', 'v1=' + 'a'.repeat(64), 't=x,v1=' + 'a'.repeat(64), 't=1,t=2,v1=' + 'a'.repeat(64), 't=1,v1=short', 'garbage']) {
      expect(parseSignatureHeader(h), h).toBeNull();
    }
    expect(parseSignatureHeader(`t=5,v1=${'a'.repeat(64)},v1=${'b'.repeat(64)}`)).toEqual({ t: 5, v1: ['a'.repeat(64), 'b'.repeat(64)] });
  });

  it('verifySignature is false when the worker holds no key', async () => {
    const h = await signatureHeader(body, [KEY], NOW_MS / 1000);
    expect(await verifySignature(h, body, '', NOW_MS / 1000)).toBe(false);
  });
});
