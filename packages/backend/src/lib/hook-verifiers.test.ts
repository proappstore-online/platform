import { describe, expect, it } from 'vitest';
import { encodeEnvelopeBody, hookHeaders, sha256OfBytes, validateHookVerify, verifyHookDelivery } from './hook-verifiers.js';

// #256: the platform verifies an inbound delivery before any app code runs, on
// the exact bytes, in constant time; and derives the key it de-duplicates on —
// from signed bytes only (#317), with the sender's unsigned id kept for display.

const SECRET = 'whsec_test_secret';
const enc = new TextEncoder();
const body = enc.encode('{"action":"opened","id":"evt_1","type":"issues.opened"}');

async function hmacHex(secret: string, data: Uint8Array | string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? enc.encode(data) : data);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const b64 = (hex: string) => btoa(String.fromCharCode(...hex.match(/../g)!.map((h) => parseInt(h, 16))));

describe('github-hmac-sha256', () => {
  const verify = { kind: 'github-hmac-sha256' as const, secret: 'GH' };
  it('accepts sha256=<hmac of the raw body>; the replay key is the body hash, X-GitHub-Delivery only the sender id', async () => {
    const headers = new Headers({ 'x-hub-signature-256': `sha256=${await hmacHex(SECRET, body)}`, 'x-github-delivery': 'd1', 'x-github-event': 'issues' });
    expect(await verifyHookDelivery(verify, SECRET, body, headers)).toEqual({ replayKey: await sha256OfBytes(body), deliveryId: 'd1', event: 'issues' });
  });
  it('#317: the same signed body under another X-GitHub-Delivery has the same replay key; another body does not', async () => {
    const sig = `sha256=${await hmacHex(SECRET, body)}`;
    const a = await verifyHookDelivery(verify, SECRET, body, new Headers({ 'x-hub-signature-256': sig, 'x-github-delivery': 'd1' }));
    const replay = await verifyHookDelivery(verify, SECRET, body, new Headers({ 'x-hub-signature-256': sig, 'x-github-delivery': 'forged-d2' }));
    expect(replay!.replayKey).toBe(a!.replayKey);
    expect(replay!.deliveryId).toBe('forged-d2');
    const other = enc.encode('{"action":"closed"}');
    const b = await verifyHookDelivery(verify, SECRET, other, new Headers({ 'x-hub-signature-256': `sha256=${await hmacHex(SECRET, other)}`, 'x-github-delivery': 'd1' }));
    expect(b!.replayKey).not.toBe(a!.replayKey);
  });
  it('refuses a wrong secret, a tampered body, a missing prefix and no header', async () => {
    const good = await hmacHex(SECRET, body);
    expect(await verifyHookDelivery(verify, SECRET, body, new Headers({ 'x-hub-signature-256': `sha256=${await hmacHex('other', body)}` }))).toBeNull();
    expect(await verifyHookDelivery(verify, SECRET, enc.encode('{"x":1}'), new Headers({ 'x-hub-signature-256': `sha256=${good}` }))).toBeNull();
    expect(await verifyHookDelivery(verify, SECRET, body, new Headers({ 'x-hub-signature-256': good }))).toBeNull();
    expect(await verifyHookDelivery(verify, SECRET, body, new Headers())).toBeNull();
    expect(await verifyHookDelivery(verify, '', body, new Headers({ 'x-hub-signature-256': `sha256=${good}` }))).toBeNull();
  });
  it('without X-GitHub-Delivery, there is no sender id; the replay key is still the body hash', async () => {
    const headers = new Headers({ 'x-hub-signature-256': `sha256=${await hmacHex(SECRET, body)}` });
    expect(await verifyHookDelivery(verify, SECRET, body, headers)).toMatchObject({ replayKey: await sha256OfBytes(body), deliveryId: null });
  });
});

describe('stripe (lib/stripe.ts, 5-minute window)', () => {
  const verify = { kind: 'stripe' as const, secret: 'STRIPE' };
  const sign = async (t: number, payload = body) => `t=${t},v1=${await hmacHex(SECRET, `${t}.${new TextDecoder().decode(payload)}`)}`;
  it('accepts a fresh signature; the replay key is the signed event id (unchanged by #317)', async () => {
    const t = Math.floor(Date.now() / 1000);
    expect(await verifyHookDelivery(verify, SECRET, body, new Headers({ 'stripe-signature': await sign(t) }))).toEqual({ replayKey: 'evt_1', deliveryId: 'evt_1', event: 'issues.opened' });
    // Stripe's own retry re-signs with a new timestamp: still the same event id, so still one delivery.
    expect((await verifyHookDelivery(verify, SECRET, body, new Headers({ 'stripe-signature': await sign(t - 60) })))!.replayKey).toBe('evt_1');
  });
  it('refuses a signature older than 5 minutes and a body that is not UTF-8', async () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    expect(await verifyHookDelivery(verify, SECRET, body, new Headers({ 'stripe-signature': await sign(old) }))).toBeNull();
    const notUtf8 = new Uint8Array([0xff, 0xfe, 0x00]);
    expect(await verifyHookDelivery(verify, SECRET, notUtf8, new Headers({ 'stripe-signature': 't=1,v1=00' }))).toBeNull();
  });
  it('a signed body that is not JSON gets the body hash as its id', async () => {
    const t = Math.floor(Date.now() / 1000);
    const text = enc.encode('plain');
    expect(await verifyHookDelivery(verify, SECRET, text, new Headers({ 'stripe-signature': await sign(t, text) }))).toEqual({ replayKey: await sha256OfBytes(text), deliveryId: null, event: null });
  });
});

describe('hmac-sha256 and secret-token', () => {
  it('hmac-sha256: default X-Signature hex, or a configured header, prefix and base64; id_header is the sender id only', async () => {
    const hex = await hmacHex(SECRET, body);
    const hash = await sha256OfBytes(body);
    expect(await verifyHookDelivery({ kind: 'hmac-sha256', secret: 'S' }, SECRET, body, new Headers({ 'x-signature': hex.toUpperCase() })))
      .toEqual({ replayKey: hash, deliveryId: null, event: null });
    const custom = { kind: 'hmac-sha256' as const, secret: 'S', header: 'X-Sig', prefix: 'v1,', encoding: 'base64' as const, id_header: 'X-Id' };
    expect(await verifyHookDelivery(custom, SECRET, body, new Headers({ 'x-sig': `v1,${b64(hex)}`, 'x-id': 'abc' }))).toEqual({ replayKey: hash, deliveryId: 'abc', event: null });
    // #317: a fresh id_header does not make a replay new.
    expect((await verifyHookDelivery(custom, SECRET, body, new Headers({ 'x-sig': `v1,${b64(hex)}`, 'x-id': 'forged' })))!.replayKey).toBe(hash);
    expect(await verifyHookDelivery(custom, SECRET, body, new Headers({ 'x-sig': b64(hex) }))).toBeNull();
    expect(await verifyHookDelivery(custom, SECRET, body, new Headers({ 'x-sig': `v1,${hex}` }))).toBeNull();
  });
  it('secret-token: X-PAS-Hook-Token must equal the secret', async () => {
    const verify = { kind: 'secret-token' as const, secret: 'T' };
    expect(await verifyHookDelivery(verify, SECRET, body, new Headers({ 'x-pas-hook-token': SECRET }))).toEqual({ replayKey: await sha256OfBytes(body), deliveryId: null, event: null });
    expect(await verifyHookDelivery(verify, SECRET, body, new Headers({ 'x-pas-hook-token': `${SECRET}x` }))).toBeNull();
    expect(await verifyHookDelivery(verify, SECRET, body, new Headers())).toBeNull();
  });
  it('github-app never verifies on the per-app URL', async () => {
    expect(await verifyHookDelivery({ kind: 'github-app' }, SECRET, body, new Headers({ 'x-pas-hook-token': SECRET }))).toBeNull();
  });
});

describe('what reaches the worker', () => {
  it('passes only the allowlisted headers — never a signature, token, authorization or cookie', () => {
    const h = hookHeaders(new Headers({
      'x-github-event': 'push', 'x-github-delivery': 'd', 'content-type': 'application/json', 'user-agent': 'GitHub-Hookshot',
      'x-hub-signature-256': 'sha256=x', 'stripe-signature': 't=1', 'x-pas-hook-token': 'tok', 'x-signature': 's', authorization: 'Bearer x', cookie: 'a=b',
    }));
    expect(Object.keys(h).sort()).toEqual(['content-type', 'user-agent', 'x-github-delivery', 'x-github-event']);
  });
  it('encodes a textual UTF-8 body as utf8 and anything else as base64', () => {
    expect(encodeEnvelopeBody(body, 'application/json; charset=utf-8')).toEqual({ body: new TextDecoder().decode(body), body_encoding: 'utf8' });
    expect(encodeEnvelopeBody(enc.encode('a=1'), 'application/x-www-form-urlencoded').body_encoding).toBe('utf8');
    expect(encodeEnvelopeBody(new Uint8Array([0xff, 0x00, 0x10]), 'application/octet-stream')).toEqual({ body: '/wAQ', body_encoding: 'base64' });
    expect(encodeEnvelopeBody(new Uint8Array([0xff, 0xfe]), 'text/plain').body_encoding).toBe('base64');
    expect(encodeEnvelopeBody(body, null).body_encoding).toBe('base64');
  });
});

describe('validateHookVerify', () => {
  it('accepts each kind with its options', () => {
    expect(validateHookVerify({ kind: 'github-hmac-sha256', secret: 'GITHUB_WEBHOOK_SECRET' }, 'h')).toEqual({ verify: { kind: 'github-hmac-sha256', secret: 'GITHUB_WEBHOOK_SECRET' } });
    expect(validateHookVerify({ kind: 'hmac-sha256', secret: 'S', header: 'X-Sig', prefix: 'sha256=', encoding: 'base64', id_header: 'X-Id' }, 'h')).toMatchObject({ verify: { header: 'X-Sig' } });
    expect(validateHookVerify({ kind: 'github-app' }, 'h')).toEqual({ verify: { kind: 'github-app' } });
  });
  it('refuses unknown kinds and fields, missing or malformed secrets, and options on the wrong kind', () => {
    for (const [raw, error] of [
      [null, 'must be an object'],
      [{ kind: 'basic-auth', secret: 'S' }, 'kind must be one of'],
      [{ kind: 'stripe' }, 'secret must name an app secret'],
      [{ kind: 'stripe', secret: 'lower' }, 'secret must name an app secret'],
      [{ kind: 'github-app', secret: 'S' }, 'has no secret'],
      [{ kind: 'stripe', secret: 'S', header: 'X' }, 'applies only to kind hmac-sha256'],
      [{ kind: 'stripe', secret: 'S', id_header: 'X' }, 'applies only to kinds'],
      [{ kind: 'hmac-sha256', secret: 'S', header: 'bad header' }, 'must be a header name'],
      [{ kind: 'hmac-sha256', secret: 'S', encoding: 'hex64' }, 'hex or base64'],
      [{ kind: 'hmac-sha256', secret: 'S', prefix: 'x'.repeat(40) }, 'prefix must be'],
      [{ kind: 'stripe', secret: 'S', query: 'token' }, 'unknown field "query"'],
    ] as const) {
      const r = validateHookVerify(raw, 'h');
      expect('error' in r && r.error, JSON.stringify(raw)).toContain(error);
    }
  });
});
