/**
 * Cloudflare Turnstile — bot/abuse protection on the anonymous and self-service
 * entry points (#26): credential self-registration on the API and browser-driven
 * publishes on the admin Worker.
 *
 * Shape: the page renders the Turnstile widget (site key, public) and sends the
 * resulting token with the request — `CF-Turnstile-Response` header or a
 * `turnstileToken` body field; the Worker verifies it once against siteverify
 * with the secret key. Tokens are single-use and expire after 5 minutes.
 *
 * Configuration is deliberately all-or-nothing per Worker: enforcement is on
 * only when BOTH `TURNSTILE_SITE_KEY` (var) and `TURNSTILE_SECRET_KEY` (secret)
 * are set, so a half-configured Worker (secret set, site key not yet published
 * to the forms) never locks every caller out. Unset = the check is inert.
 *
 * Verification failure is fail-closed: a token the challenge service rejects,
 * and a challenge service that cannot be reached, both refuse the request —
 * the caller answers 403 and 503 respectively and the form re-renders the widget.
 */

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Request header the token may travel in. */
export const TURNSTILE_TOKEN_HEADER = 'CF-Turnstile-Response';
/** JSON body field the token may travel in (the SDK sends this). */
export const TURNSTILE_TOKEN_FIELD = 'turnstileToken';

/** Cloudflare's documented test keys: every token passes. For dev and CI only. */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
export const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

export interface TurnstileConfig {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export type TurnstileReason = 'not-configured' | 'ok' | 'missing-token' | 'rejected' | 'unavailable';

export interface TurnstileResult {
  ok: boolean;
  reason: TurnstileReason;
  /** siteverify `error-codes` on a rejection. */
  errorCodes?: string[];
}

/** Enforcement is on only when both halves are configured (see the module comment). */
export function turnstileEnabled(env: TurnstileConfig): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY?.trim()) && Boolean(env.TURNSTILE_SECRET_KEY?.trim());
}

/** The token from the header, else from the parsed JSON body; null when absent. */
export function turnstileTokenFrom(headers: Headers, body: unknown): string | null {
  const fromHeader = headers.get(TURNSTILE_TOKEN_HEADER)?.trim();
  if (fromHeader) return fromHeader;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const v = (body as Record<string, unknown>)[TURNSTILE_TOKEN_FIELD];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Verify a token with siteverify. `expectedAction` pins the token to the form it
 * was issued for (the widget's `data-action`), so a token minted on a sign-up
 * page cannot be replayed on a publish. `remoteIp` (CF-Connecting-IP) lets the
 * challenge service check the token was solved by the same client.
 */
export async function verifyTurnstile(opts: {
  env: TurnstileConfig;
  token: string | null;
  remoteIp?: string | null;
  expectedAction?: string;
  fetchImpl?: typeof fetch;
}): Promise<TurnstileResult> {
  if (!turnstileEnabled(opts.env)) return { ok: true, reason: 'not-configured' };
  if (!opts.token) return { ok: false, reason: 'missing-token' };
  // A Turnstile token is at most 2048 characters; anything longer is not one.
  if (opts.token.length > 2048) return { ok: false, reason: 'rejected', errorCodes: ['invalid-input-response'] };

  const form = new URLSearchParams();
  form.set('secret', opts.env.TURNSTILE_SECRET_KEY!);
  form.set('response', opts.token);
  if (opts.remoteIp) form.set('remoteip', opts.remoteIp);

  let data: { success?: boolean; action?: string; 'error-codes'?: string[] };
  try {
    const res = await (opts.fetchImpl ?? fetch)(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    data = (await res.json()) as typeof data;
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  if (data.success !== true) return { ok: false, reason: 'rejected', errorCodes: data['error-codes'] ?? [] };
  if (opts.expectedAction && data.action !== opts.expectedAction) {
    return { ok: false, reason: 'rejected', errorCodes: ['action-mismatch'] };
  }
  return { ok: true, reason: 'ok' };
}

/** Map a failed result to the HTTP status + message a route answers with. */
export function turnstileFailure(result: TurnstileResult): { status: 403 | 503; error: string } {
  if (result.reason === 'unavailable') return { status: 503, error: 'bot check unavailable — please try again' };
  if (result.reason === 'missing-token') return { status: 403, error: 'bot check required' };
  return { status: 403, error: 'bot check failed' };
}
