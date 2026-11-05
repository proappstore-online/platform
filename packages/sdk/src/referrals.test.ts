import { describe, expect, it, vi } from 'vitest';
import { initPro } from './index.js';
import { Auth } from './auth.js';
import { REFERRAL_CAPTURE_TTL_MS, Referrals, type ReferralStorage } from './referrals.js';

// #550: deterministic capture across the sign-in redirect and claim after sign-in. No DOM, no network.

const CODE = 'ABCD2345';
const memory = (): ReferralStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup(opts: { token?: string | null; storage?: ReturnType<typeof memory>; appId?: string; now?: { t: number } } = {}) {
  const storage = opts.storage ?? memory();
  const clock = opts.now ?? { t: 1_000_000 };
  const fetcher = vi.fn(async (..._args: unknown[]) => reply({ credited: false, state: 'pending' }));
  const auth = { token: opts.token === undefined ? 'session' : opts.token, authenticatedFetch: (input: string | URL, init?: RequestInit) => fetcher(String(input), init) as Promise<Response> };
  const referrals = new Referrals(opts.appId ?? 'shop', 'https://api.test', auth, storage, () => clock.t);
  return { referrals, storage, fetcher, auth, clock };
}

describe('capture', () => {
  it('keeps a valid ref code from the link, normalised, without touching the URL', () => {
    const { referrals, storage } = setup();
    expect(referrals.capture(`https://shop.proappstore.online/deep/page?x=1&ref=${CODE.toLowerCase().slice(0, 4)}-${CODE.slice(4)}#frag`)).toBe(CODE);
    expect(referrals.pending()).toEqual({ code: CODE, capturedAt: 1_000_000 });
    expect(JSON.parse(storage.map.get('pas_referral')!)).toEqual({ code: CODE, appId: 'shop', capturedAt: 1_000_000 });
  });

  it('ignores a missing, malformed or look-alike code and never throws', () => {
    const { referrals, storage } = setup();
    for (const href of ['https://shop.test/', 'https://shop.test/?ref=', 'https://shop.test/?ref=short', 'https://shop.test/?ref=ABCD234I', 'https://shop.test/?ref=ABCD234O', 'https://shop.test/?ref=<script>', 'https://shop.test/?ref=ABCD23456', 'not a url', '']) {
      expect(referrals.capture(href)).toBeNull();
    }
    expect(storage.map.size).toBe(0);
  });

  it('the first valid code stands: a later link does not replace it', () => {
    const { referrals } = setup();
    referrals.capture(`https://shop.test/?ref=${CODE}`);
    expect(referrals.capture('https://shop.test/?ref=ZZZZ2222')).toBe(CODE);
    expect(referrals.pending()!.code).toBe(CODE);
  });

  it('survives the trip to PAS sign-in and back: the landing page captured it, the return page has no ref', () => {
    const storage = memory();
    setup({ storage }).referrals.capture(`https://shop.test/landing?ref=${CODE}`);
    const returned = setup({ storage }).referrals; // a new page load after the redirect
    expect(returned.capture('https://shop.test/landing')).toBe(CODE);
    expect(returned.pending()!.code).toBe(CODE);
  });

  it('is bounded: the code expires, and a clock that went backwards does not extend it', () => {
    const { referrals, clock, storage } = setup();
    referrals.capture(`https://shop.test/?ref=${CODE}`);
    clock.t += REFERRAL_CAPTURE_TTL_MS;
    expect(referrals.pending()).not.toBeNull();
    clock.t += 1;
    expect(referrals.pending()).toBeNull();
    expect(storage.map.size).toBe(0);
    expect(referrals.capture(`https://shop.test/?ref=ZZZZ2222`)).toBe('ZZZZ2222'); // an expired code makes room for a new one
    storage.map.set('pas_referral', JSON.stringify({ code: CODE, appId: 'shop', capturedAt: clock.t + 10 * 60_000 }));
    expect(referrals.pending()).toBeNull();
  });

  it('a code held for another app, or a damaged record, is dropped', () => {
    const storage = memory();
    storage.map.set('pas_referral', JSON.stringify({ code: CODE, appId: 'other', capturedAt: 1_000_000 }));
    expect(setup({ storage }).referrals.pending()).toBeNull();
    storage.map.set('pas_referral', '{not json');
    expect(setup({ storage }).referrals.pending()).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it('still returns the code when storage is unavailable', () => {
    const referrals = new Referrals('shop', 'https://api.test', { token: null, authenticatedFetch: async () => reply({}) }, null);
    expect(referrals.capture(`https://shop.test/?ref=${CODE}`)).toBe(CODE);
    expect(referrals.pending()).toBeNull();
  });
});

describe('claim', () => {
  it('claims after cookie sign-in through real auth mediation, without exposing a bearer token (#553)', async () => {
    const storage = memory();
    vi.stubGlobal('window', { location: { hash: '', href: 'https://shop.proappstore.online/', origin: 'https://shop.proappstore.online', pathname: '/', search: '' } });
    const fetcher = vi.fn(async (input: string | URL, _init?: RequestInit) => String(input).includes('/auth/me')
      ? reply({ id: 'synthetic', login: 'synthetic', roles: [], appRoles: {} })
      : reply({ credited: false, state: 'pending' }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const auth = new Auth('shop', 'https://api.proappstore.online', 'platform-cookie');
      const referrals = new Referrals('shop', 'https://api.proappstore.online', auth, storage);
      referrals.capture(`https://shop.proappstore.online/?ref=${CODE}`);
      expect(await referrals.claim()).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
      await auth.init();
      expect(auth.isSignedIn).toBe(true);
      expect(auth.token).toBeNull();
      expect(await referrals.claim()).toEqual({ credited: false, state: 'pending' });
      const [url, options] = fetcher.mock.calls.at(-1)!;
      expect(String(url)).toBe('/.pas/api/v1/apps/shop/referrals/claim');
      expect(options?.credentials).toBe('same-origin');
      expect(new Headers(options?.headers).get('Authorization')).toBeNull();
      expect(referrals.pending()).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it('sends nothing without a code or without a signed-in person, and keeps the code for later', async () => {
    const none = setup();
    expect(await none.referrals.claim()).toBeNull();
    const signedOut = setup({ token: null });
    signedOut.referrals.capture(`https://shop.test/?ref=${CODE}`);
    expect(await signedOut.referrals.claim()).toBeNull();
    expect(none.fetcher).not.toHaveBeenCalled();
    expect(signedOut.fetcher).not.toHaveBeenCalled();
    expect(signedOut.referrals.pending()).not.toBeNull();
  });

  it('posts only the public code to this app\'s claim route, with no promoter or user identifier', async () => {
    const { referrals, fetcher } = setup();
    referrals.capture(`https://shop.test/?ref=${CODE}`);
    expect(await referrals.claim()).toEqual({ credited: false, state: 'pending' });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/apps/shop/referrals/claim');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ code: CODE });
  });

  it.each(['pending', 'confirmed', 'not_eligible', 'invalid_code', 'already_attributed', 'unverified_origin'] as const)('a definite "%s" answer clears the held code', async (state) => {
    const { referrals, fetcher } = setup();
    fetcher.mockResolvedValueOnce(reply({ credited: state === 'confirmed', state }));
    referrals.capture(`https://shop.test/?ref=${CODE}`);
    expect(await referrals.claim()).toEqual({ credited: state === 'confirmed', state });
    expect(referrals.pending()).toBeNull();
    expect(await referrals.claim()).toBeNull(); // and is not sent again
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the code to retry after a server or network failure', async () => {
    const { referrals, fetcher } = setup();
    referrals.capture(`https://shop.test/?ref=${CODE}`);
    fetcher.mockResolvedValueOnce(reply({ error: 'x' }, 500));
    expect(await referrals.claim()).toBeNull();
    fetcher.mockRejectedValueOnce(new Error('offline'));
    expect(await referrals.claim()).toBeNull();
    fetcher.mockResolvedValueOnce(reply('not an answer'));
    expect(await referrals.claim()).toBeNull();
    expect(referrals.pending()!.code).toBe(CODE);
    expect(await referrals.claim()).toEqual({ credited: false, state: 'pending' });
    expect(referrals.pending()).toBeNull();
  });

  it('concurrent claims share one request', async () => {
    const { referrals, fetcher } = setup();
    referrals.capture(`https://shop.test/?ref=${CODE}`);
    const results = await Promise.all([referrals.claim(), referrals.claim(), referrals.claim()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });
});

describe('the SDK starts it', () => {
  it('captures on construction and claims whenever a person is signed in, never when signed out', () => {
    const capture = vi.spyOn(Referrals.prototype, 'capture').mockReturnValue(null);
    const claim = vi.spyOn(Referrals.prototype, 'claim').mockResolvedValue(null);
    try {
      const sdk = initPro({ appId: 'shop' });
      expect(sdk.referrals).toBeInstanceOf(Referrals);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(claim).not.toHaveBeenCalled(); // signed out at construction
      const auth = sdk.auth as unknown as { session: unknown; emit(): void };
      auth.session = { user: { id: 'gh:1', login: 'x' } };
      auth.emit();
      expect(claim).toHaveBeenCalledTimes(1);
      auth.session = null;
      auth.emit();
      expect(claim).toHaveBeenCalledTimes(1);
    } finally {
      capture.mockRestore();
      claim.mockRestore();
    }
  });
});

describe('public contributor reads (#551)', () => {
  const readsFrom = (respond: (url: string) => Response) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (input: unknown, init?: RequestInit) => { calls.push({ url: String(input), ...(init ? { init } : {}) }); return respond(String(input)); }) as typeof fetch;
    const referrals = new Referrals('shop', 'https://api.test', { token: null, authenticatedFetch: async () => reply({}) }, null, Date.now, fetcher);
    return { referrals, calls };
  };

  it('loads the public contributor list for this app, without signing in, with the period in the query', async () => {
    const body = { version: 1, app_id: 'shop', period: { from: 1, to: 2, from_iso: null, to_iso: null }, contributors: [] };
    const { referrals, calls } = readsFrom(() => reply(body));
    expect(await referrals.contributors({ from: '2026-10-01', to: 1_800_000_000_000 })).toEqual(body);
    expect(calls[0]!.url).toBe('https://api.test/v1/storefront/apps/shop/contributors?from=2026-10-01&to=1800000000000');
    expect(calls[0]!.init).toBeUndefined(); // no credentials, no body
    await referrals.contributors();
    expect(calls[1]!.url).toBe('https://api.test/v1/storefront/apps/shop/contributors');
  });

  it('loads one card by the opaque promoter id, encoded, and treats a 404 as no card', async () => {
    const { referrals, calls } = readsFrom((url) => (url.includes('/missing/') ? reply('not found', 404) : reply({ display_name: 'Pat', label: null })));
    expect(await referrals.publicCard('missing')).toBeNull();
    expect(await referrals.publicCard('a/b c')).toMatchObject({ display_name: 'Pat' });
    expect(calls[1]!.url).toBe('https://api.test/v1/apps/shop/promoters/a%2Fb%20c/public-card');
  });

  it('a private or unknown app is null, and any other failure is an error', async () => {
    expect(await readsFrom(() => reply('not found', 404)).referrals.contributors()).toBeNull();
    await expect(readsFrom(() => reply('boom', 500)).referrals.contributors()).rejects.toThrow(/500/);
    await expect(readsFrom(() => reply('boom', 503)).referrals.publicCard('x')).rejects.toThrow(/503/);
  });
});
