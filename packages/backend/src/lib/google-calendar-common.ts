import type { Env } from '../types.js';
import { timingSafeEqual } from './bytes.js';

export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'openid', 'email',
];
export class GoogleCalendarError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export const googleConfigured = (env: Env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.APP_SECRET_KEK && env.SESSION_SIGNING_KEY);
export const callbackUrl = (env: Env) => `${(env.APP_BASE || 'https://api.proappstore.online').replace(/\/$/, '')}/v1/connectors/google-calendar/callback`;
const bytes = (s: string) => new TextEncoder().encode(s);
const encode = (v: Uint8Array) => btoa(String.fromCharCode(...v)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = (s: string) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export const randomState = () => encode(crypto.getRandomValues(new Uint8Array(32)));
export const hashState = async (s: string) => encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(s))));
async function sign(env: Env, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', bytes(env.SESSION_SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(value))));
}
export const pkceVerifier = (env: Env, state: string) => sign(env, `google-calendar-pkce:${state}`);

/** Resource receipts constrain Meet reads to conferences discovered through a granted Calendar event. */
export async function resourceReceipt(env: Env, grantId: string, resource: string, now = Date.now()): Promise<string> {
  const payload = encode(bytes(JSON.stringify({ grantId, resource, expires: now + 300_000 })));
  return `${payload}.${await sign(env, `google-calendar-resource:${payload}`)}`;
}
export async function verifyResourceReceipt(env: Env, receipt: unknown, grantId: string, resource: string, now = Date.now()): Promise<void> {
  try {
    if (typeof receipt !== 'string' || receipt.length > 4096) throw new Error();
    const [payload, signature, extra] = receipt.split('.');
    if (!payload || !signature || extra || !timingSafeEqual(bytes(signature), bytes(await sign(env, `google-calendar-resource:${payload}`)))) throw new Error();
    const claim = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (claim.grantId !== grantId || claim.resource !== resource || claim.expires <= now || claim.expires > now + 300_000) throw new Error();
  } catch { throw new GoogleCalendarError('invalid_resource_receipt', 403); }
}

export function textInput(value: unknown, pattern: RegExp, code = 'invalid_input'): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new GoogleCalendarError(code);
  return value;
}
export const calendarId = (value: unknown) => {
  const id = textInput(value, /^[A-Za-z0-9._+\-#@]{3,254}$/);
  if (id === 'primary') throw new GoogleCalendarError('exact_calendar_required');
  return id;
};

/** Fixed Google URLs only; no redirect, response-body logging, or unbounded response. */
export async function googleJson(url: URL | string, init: RequestInit = {}): Promise<Record<string, any>> {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new GoogleCalendarError('google_unavailable', 502); }
  if (!response.ok) throw new GoogleCalendarError(({ 400: 'google_auth', 401: 'google_auth', 403: 'google_forbidden', 404: 'google_not_found', 429: 'google_rate_limited' } as Record<number, string>)[response.status] ?? 'google_unavailable', 502);
  const reader = response.body?.getReader();
  if (!reader) throw new GoogleCalendarError('google_invalid_response', 502);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_048_576) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    const body = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { body.set(part, offset); offset += part.length; }
    const result = JSON.parse(new TextDecoder().decode(body));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new GoogleCalendarError('google_invalid_response', 502); }
}
