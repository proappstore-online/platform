import { describe, expect, it, vi } from 'vitest';
import {
  TURNSTILE_VERIFY_URL,
  turnstileEnabled,
  turnstileFailure,
  turnstileTokenFrom,
  verifyTurnstile,
} from './turnstile.ts';

const ENV = { TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' };

describe('turnstileEnabled', () => {
  it('is on only when BOTH the site key and the secret are set (a half-configured Worker stays inert)', () => {
    expect(turnstileEnabled(ENV)).toBe(true);
    expect(turnstileEnabled({})).toBe(false);
    expect(turnstileEnabled({ TURNSTILE_SECRET_KEY: 'secret' })).toBe(false);
    expect(turnstileEnabled({ TURNSTILE_SITE_KEY: 'site' })).toBe(false);
    expect(turnstileEnabled({ TURNSTILE_SITE_KEY: ' ', TURNSTILE_SECRET_KEY: 'secret' })).toBe(false);
  });
});

describe('turnstileTokenFrom', () => {
  it('prefers the header, falls back to the body field, and ignores junk', () => {
    expect(turnstileTokenFrom(new Headers({ 'CF-Turnstile-Response': ' h ' }), { turnstileToken: 'b' })).toBe('h');
    expect(turnstileTokenFrom(new Headers(), { turnstileToken: 'b' })).toBe('b');
    expect(turnstileTokenFrom(new Headers(), { turnstileToken: 7 })).toBeNull();
    expect(turnstileTokenFrom(new Headers(), ['x'])).toBeNull();
    expect(turnstileTokenFrom(new Headers(), null)).toBeNull();
    expect(turnstileTokenFrom(new Headers({ 'CF-Turnstile-Response': '' }), {})).toBeNull();
  });
});

describe('verifyTurnstile', () => {
  it('passes without calling out when not configured', async () => {
    const fetchImpl = vi.fn();
    expect(await verifyTurnstile({ env: {}, token: null, fetchImpl })).toEqual({ ok: true, reason: 'not-configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a missing token before calling out', async () => {
    const fetchImpl = vi.fn();
    expect(await verifyTurnstile({ env: ENV, token: null, fetchImpl })).toEqual({ ok: false, reason: 'missing-token' });
    expect(await verifyTurnstile({ env: ENV, token: 'x'.repeat(2049), fetchImpl })).toMatchObject({ ok: false, reason: 'rejected' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts secret + response + remoteip as a form to siteverify and accepts success with the expected action', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(TURNSTILE_VERIFY_URL);
      expect(init?.method).toBe('POST');
      expect(new URLSearchParams(String(init?.body))).toEqual(new URLSearchParams({ secret: 'secret', response: 'tok', remoteip: '203.0.113.7' }));
      return Response.json({ success: true, action: 'register' });
    }) as unknown as typeof fetch;
    expect(await verifyTurnstile({ env: ENV, token: 'tok', remoteIp: '203.0.113.7', expectedAction: 'register', fetchImpl })).toEqual({ ok: true, reason: 'ok' });
  });

  it('rejects on success:false (with the codes) and on an action minted for another form', async () => {
    const rejected = (async () => Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] })) as unknown as typeof fetch;
    expect(await verifyTurnstile({ env: ENV, token: 'tok', fetchImpl: rejected })).toEqual({ ok: false, reason: 'rejected', errorCodes: ['timeout-or-duplicate'] });
    const other = (async () => Response.json({ success: true, action: 'publish' })) as unknown as typeof fetch;
    expect(await verifyTurnstile({ env: ENV, token: 'tok', expectedAction: 'register', fetchImpl: other })).toEqual({ ok: false, reason: 'rejected', errorCodes: ['action-mismatch'] });
    // No expected action → the action is not checked.
    expect(await verifyTurnstile({ env: ENV, token: 'tok', fetchImpl: other })).toEqual({ ok: true, reason: 'ok' });
  });

  it('fails closed when the challenge service is down or answers garbage', async () => {
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await verifyTurnstile({ env: ENV, token: 'tok', fetchImpl: down })).toEqual({ ok: false, reason: 'unavailable' });
    const five = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    expect(await verifyTurnstile({ env: ENV, token: 'tok', fetchImpl: five })).toEqual({ ok: false, reason: 'unavailable' });
    const garbage = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    expect(await verifyTurnstile({ env: ENV, token: 'tok', fetchImpl: garbage })).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('turnstileFailure', () => {
  it('maps reasons to 403 (missing / rejected) and 503 (unavailable)', () => {
    expect(turnstileFailure({ ok: false, reason: 'missing-token' })).toEqual({ status: 403, error: 'bot check required' });
    expect(turnstileFailure({ ok: false, reason: 'rejected' })).toEqual({ status: 403, error: 'bot check failed' });
    expect(turnstileFailure({ ok: false, reason: 'unavailable' })).toEqual({ status: 503, error: 'bot check unavailable — please try again' });
  });
});
