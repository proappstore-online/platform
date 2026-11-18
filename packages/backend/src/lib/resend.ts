/**
 * The Resend API as the verified-app-email feature uses it (#566): domains, sends
 * with an idempotency key, received mail, and webhook signature verification.
 * Every call goes through global `fetch`, so tests fake the provider and the
 * platform makes no provider call without `RESEND_API_KEY`. The legacy platform
 * sender in lib/email.ts is separate and unchanged.
 */

const API = 'https://api.resend.com';
const TIMEOUT_MS = 15_000;
/** Svix replay window for webhook timestamps. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface ResendDnsRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl?: string;
  priority?: number;
  status?: string;
}

export interface ResendDomain {
  id: string;
  name: string;
  /** not_started | pending | verified | failed | temporarily_failed */
  status: string;
  records: ResendDnsRecord[];
}

/** The provider answered, but not with success. `retryable`: it may not have processed the request. */
export class ResendError extends Error {
  constructor(readonly status: number, readonly retryable: boolean, detail: string) {
    super(`resend ${status}: ${detail}`);
  }
}

async function call<T>(apiKey: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Network failure or timeout: the provider may or may not have acted.
    throw new ResendError(0, true, String((e as Error)?.message ?? e).slice(0, 200));
  }
  const text = await res.text();
  if (!res.ok) throw new ResendError(res.status, res.status >= 500 || res.status === 429 || res.status === 409, text.slice(0, 300));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ResendError(res.status, true, 'unreadable response');
  }
}

const normalizeDomain = (d: Partial<ResendDomain> & { id: string }): ResendDomain => ({
  id: d.id, name: String(d.name ?? ''), status: String(d.status ?? 'not_started'), records: Array.isArray(d.records) ? d.records : [],
});

export async function createDomain(apiKey: string, name: string, receiving: boolean): Promise<ResendDomain> {
  return normalizeDomain(await call(apiKey, 'POST', '/domains', {
    name, capabilities: { sending: 'enabled', receiving: receiving ? 'enabled' : 'disabled' },
  }));
}

/** Ask the provider to re-check DNS, then read the result. */
export async function verifyDomain(apiKey: string, id: string): Promise<ResendDomain> {
  await call(apiKey, 'POST', `/domains/${encodeURIComponent(id)}/verify`);
  return normalizeDomain(await call(apiKey, 'GET', `/domains/${encodeURIComponent(id)}`));
}

export async function deleteDomain(apiKey: string, id: string): Promise<void> {
  await call(apiKey, 'DELETE', `/domains/${encodeURIComponent(id)}`);
}

export interface ResendSend {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  headers?: Record<string, string>;
}

/** The provider message id. `idempotencyKey` makes a retry return the same message instead of sending twice. */
export async function sendMessage(apiKey: string, message: ResendSend, idempotencyKey: string): Promise<string> {
  const out = await call<{ id?: unknown }>(apiKey, 'POST', '/emails', message, { 'Idempotency-Key': idempotencyKey });
  if (typeof out.id !== 'string' || !out.id) throw new ResendError(200, true, 'no message id in the response');
  return out.id;
}

export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  message_id: string | null;
  authentication: { spf: string; dkim: string; dmarc: string } | null;
  attachments: { id: string; filename: string; content_type: string; size: number }[];
}

export async function getReceivedEmail(apiKey: string, id: string): Promise<ReceivedEmail> {
  const r = await call<Record<string, unknown>>(apiKey, 'GET', `/emails/receiving/${encodeURIComponent(id)}?html_format=cid`);
  const auth = r.authentication as Record<string, unknown> | null | undefined;
  return {
    id: String(r.id ?? id),
    from: String(r.from ?? ''),
    to: Array.isArray(r.to) ? r.to.map(String) : [],
    subject: String(r.subject ?? ''),
    text: typeof r.text === 'string' ? r.text : null,
    html: typeof r.html === 'string' ? r.html : null,
    headers: r.headers && typeof r.headers === 'object' ? Object.fromEntries(Object.entries(r.headers as object).map(([k, v]) => [k.toLowerCase(), String(v)])) : {},
    message_id: typeof r.message_id === 'string' ? r.message_id : null,
    authentication: auth ? { spf: String(auth.spf ?? 'unknown'), dkim: String(auth.dkim ?? 'unknown'), dmarc: String(auth.dmarc ?? 'unknown') } : null,
    attachments: Array.isArray(r.attachments)
      ? r.attachments.map((a) => {
        const x = a as Record<string, unknown>;
        return { id: String(x.id ?? ''), filename: String(x.filename ?? ''), content_type: String(x.content_type ?? ''), size: Number(x.size ?? 0) };
      })
      : [],
  };
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Constant-time compare of two equal-purpose base64 strings. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Resend (Svix) webhook: HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<raw body>` with the
 * base64 key after `whsec_`, compared against every `v1,<sig>` in `svix-signature`, inside the
 * timestamp tolerance. Returns the svix id (the retry-stable event id) or null for anything wrong.
 */
export async function verifyWebhook(secret: string, body: string, headers: Headers, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string | null> {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signatures = headers.get('svix-signature');
  if (!id || !timestamp || !signatures) return null;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) return null;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', b64ToBytes(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    return null;
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));
  for (const part of signatures.split(' ')) {
    const [version, sig] = part.split(',');
    if (version === 'v1' && sig && sameString(sig, expected)) return id;
  }
  return null;
}
