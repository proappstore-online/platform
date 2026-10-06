/**
 * The app-worker event envelope signature (ADR-009 §3), shared by the platform,
 * which signs, and the entry shim, which verifies. Kept free of platform imports
 * other than lib/bytes.ts, because it is bundled into the shim that runs inside
 * every app worker.
 *
 *   X-PAS-Event-Signature: t=<unix seconds>,v1=<hex hmac-sha256>[,v1=<hex>…]
 *
 * v1 = HMAC-SHA256(PAS_EVENT_KEY, "<t>.<raw body>"). Several v1 values are
 * allowed so the platform can sign with the old and the new key during a
 * rotation; one match is enough.
 */
import { timingSafeEqual } from '../lib/bytes.js';

export const SIGNATURE_HEADER = 'X-PAS-Event-Signature';
/** |now − t| beyond this is refused (ADR-009 §3, "Freshness"). */
export const MAX_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The header value for `body`, signed with every key given (current first). */
export async function signatureHeader(body: string, keys: string[], nowSeconds: number): Promise<string> {
  const t = Math.floor(nowSeconds);
  const sigs = await Promise.all(keys.map((k) => hmacHex(k, `${t}.${body}`)));
  return [`t=${t}`, ...sigs.map((s) => `v1=${s}`)].join(',');
}

/** `{ t, v1[] }`, or null when the header is absent or malformed. */
export function parseSignatureHeader(header: string | null): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 1) return null;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === 't') {
      if (t !== null || !/^\d{1,12}$/.test(value)) return null;
      t = Number(value);
    } else if (name === 'v1') {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      v1.push(value);
    }
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

/**
 * True when `header` is fresh and any of its v1 values is the HMAC of `body`
 * under `key`. Every v1 value is compared in constant time, and all of them are
 * compared, whatever matched first.
 */
export async function verifySignature(header: string | null, body: string, key: string, nowSeconds: number): Promise<boolean> {
  const parsed = parseSignatureHeader(header);
  if (!parsed || !key) return false;
  if (Math.abs(nowSeconds - parsed.t) > MAX_SKEW_SECONDS) return false;
  const expected = encoder.encode(await hmacHex(key, `${parsed.t}.${body}`));
  let ok = false;
  for (const candidate of parsed.v1) ok = timingSafeEqual(encoder.encode(candidate), expected) || ok;
  return ok;
}
