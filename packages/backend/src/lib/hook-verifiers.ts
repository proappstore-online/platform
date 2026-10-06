/**
 * Inbound-webhook verifiers (#256, ADR-009 §4: "verified by the platform before
 * any app code runs"). Not to be confused with lib/verifiers/, which holds the
 * verify-*tool* verifiers of #148.
 *
 *   kind                 signature                                           delivery id
 *   github-hmac-sha256   X-Hub-Signature-256: sha256=<hex>, HMAC of raw body  X-GitHub-Delivery
 *   stripe               Stripe-Signature t=…,v1=… (lib/stripe.ts, 5 min)     event `id` in the body
 *   hmac-sha256          configurable header/prefix, hex or base64            id_header, else SHA-256 of body
 *   secret-token         X-PAS-Hook-Token equals the secret                   id_header, else SHA-256 of body
 *   github-app           fed only by the platform's GitHub App demux (#258) — its per-app URL answers 404
 *
 * Every comparison is constant-time (lib/bytes.ts). No query-string tokens: a
 * secret in a URL leaks into logs, proxies and Referer.
 */
import { timingSafeEqual } from './bytes.js';
import { verifyWebhookSignature } from './stripe.js';

export const HOOK_VERIFY_KINDS = ['github-hmac-sha256', 'stripe', 'hmac-sha256', 'secret-token', 'github-app'] as const;
export type HookVerifyKind = (typeof HOOK_VERIFY_KINDS)[number];

export interface HookVerify {
  kind: HookVerifyKind;
  /** app_secrets name holding the shared secret (every kind but github-app). */
  secret?: string;
  /** hmac-sha256: the signature header (default X-Signature), its prefix and encoding. */
  header?: string;
  prefix?: string;
  encoding?: 'hex' | 'base64';
  /** hmac-sha256 / secret-token: a header carrying the sender's delivery id. */
  id_header?: string;
}

/** Headers the worker sees. Signature and token headers are never passed: they have done their job. */
export const HOOK_HEADER_ALLOWLIST = ['x-github-event', 'x-github-delivery', 'x-github-hook-installation-target-id', 'content-type', 'user-agent'] as const;

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const encoder = new TextEncoder();

/** A `verify` block from mcp.json, or an error. */
export function validateHookVerify(raw: unknown, where: string): { error: string } | { verify: HookVerify } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${where}.verify must be an object` };
  const v = raw as Record<string, unknown>;
  const unknown = Object.keys(v).find((k) => !['kind', 'secret', 'header', 'prefix', 'encoding', 'id_header'].includes(k));
  if (unknown) return { error: `${where}.verify: unknown field "${unknown}"` };
  if (!HOOK_VERIFY_KINDS.includes(v.kind as HookVerifyKind)) return { error: `${where}.verify.kind must be one of ${HOOK_VERIFY_KINDS.join(', ')}` };
  const kind = v.kind as HookVerifyKind;
  if (kind === 'github-app') {
    if (v.secret !== undefined) return { error: `${where}.verify: a github-app hook has no secret (the platform's GitHub App verifies it)` };
  } else if (typeof v.secret !== 'string' || !SECRET_NAME.test(v.secret)) {
    return { error: `${where}.verify.secret must name an app secret (${SECRET_NAME.source})` };
  }
  const hmacOnly = ['header', 'prefix', 'encoding'].find((k) => v[k] !== undefined);
  if (hmacOnly && kind !== 'hmac-sha256') return { error: `${where}.verify.${hmacOnly} applies only to kind hmac-sha256` };
  if (v.id_header !== undefined && kind !== 'hmac-sha256' && kind !== 'secret-token') {
    return { error: `${where}.verify.id_header applies only to kinds hmac-sha256 and secret-token` };
  }
  for (const h of ['header', 'id_header'] as const) {
    if (v[h] !== undefined && (typeof v[h] !== 'string' || !HEADER_NAME.test(v[h] as string))) return { error: `${where}.verify.${h} must be a header name` };
  }
  if (v.prefix !== undefined && (typeof v.prefix !== 'string' || v.prefix.length > 32)) return { error: `${where}.verify.prefix must be a string (max 32 chars)` };
  if (v.encoding !== undefined && v.encoding !== 'hex' && v.encoding !== 'base64') return { error: `${where}.verify.encoding must be hex or base64` };
  const verify: HookVerify = { kind };
  for (const k of ['secret', 'header', 'prefix', 'encoding', 'id_header'] as const) if (v[k] !== undefined) (verify as unknown as Record<string, unknown>)[k] = v[k];
  return { verify };
}

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const toBase64 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const same = (a: string, b: string) => timingSafeEqual(encoder.encode(a), encoder.encode(b));

async function hmac(secret: string, body: Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, body);
}

export async function sha256OfBytes(body: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', body));
}

export interface VerifiedDelivery {
  deliveryId: string;
  /** The sender's event name, where it says one (GitHub's X-GitHub-Event, Stripe's `type`). */
  event: string | null;
}

/**
 * Verify a delivery against the hook's declared verifier and derive its delivery
 * id. Null on any failure — a missing header, a bad signature, an unreadable
 * body — never an exception the caller could mistake for success.
 */
export async function verifyHookDelivery(verify: HookVerify, secret: string, body: Uint8Array, headers: Headers): Promise<VerifiedDelivery | null> {
  if (!secret) return null;
  const idFrom = async (header?: string) => (header ? headers.get(header)?.trim().slice(0, 200) : '') || sha256OfBytes(body);
  switch (verify.kind) {
    case 'github-hmac-sha256': {
      const sig = headers.get('x-hub-signature-256') ?? '';
      if (!sig.startsWith('sha256=') || !same(sig.slice(7).toLowerCase(), toHex(await hmac(secret, body)))) return null;
      return { deliveryId: headers.get('x-github-delivery')?.trim().slice(0, 200) || await sha256OfBytes(body), event: headers.get('x-github-event')?.slice(0, 100) ?? null };
    }
    case 'stripe': {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { return null; }
      if (!(await verifyWebhookSignature(text, headers.get('stripe-signature') ?? '', secret))) return null;
      let event: { id?: unknown; type?: unknown } = {};
      try { event = JSON.parse(text) as typeof event; } catch { /* signed but not JSON: id from the bytes */ }
      return {
        deliveryId: typeof event.id === 'string' && event.id ? event.id.slice(0, 200) : await sha256OfBytes(body),
        event: typeof event.type === 'string' ? event.type.slice(0, 100) : null,
      };
    }
    case 'hmac-sha256': {
      let sig = headers.get(verify.header ?? 'x-signature') ?? '';
      const prefix = verify.prefix ?? '';
      if (!sig.startsWith(prefix)) return null;
      sig = sig.slice(prefix.length);
      const mac = await hmac(secret, body);
      const expected = verify.encoding === 'base64' ? toBase64(new Uint8Array(mac)) : toHex(mac);
      if (!same(verify.encoding === 'base64' ? sig : sig.toLowerCase(), expected)) return null;
      return { deliveryId: await idFrom(verify.id_header), event: null };
    }
    case 'secret-token': {
      if (!same(headers.get('x-pas-hook-token') ?? '', secret)) return null;
      return { deliveryId: await idFrom(verify.id_header), event: null };
    }
    default:
      return null; // github-app: never verified on the per-app URL (#258)
  }
}

/** The allowlisted headers, lower-cased. */
export function hookHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HOOK_HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value !== null) out[name] = value.slice(0, 1024);
  }
  return out;
}

// The envelope body encoding lives with the shim, which needs it too (#260).
export { encodeEnvelopeBody } from '../app-worker-shim/body.js';
