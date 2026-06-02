/**
 * Shared constants, types, and helpers for the proxy/secrets/allowlist routes.
 * Extracted verbatim from secrets.ts.
 */
import { type Context } from 'hono';
import { HttpError } from '../lib/auth.js';
import { AllowlistError } from '../lib/proxy-allowlist.js';
import type { Env } from '../types.js';

/**
 * Free-tier caps. The spec (docs/APP-SECRET-PROXY.md) lists Pro tiers too,
 * but for now every app is treated as free — Pro caps land later.
 */
export const MAX_SECRETS_PER_APP = 5;
export const MAX_ALLOWLIST_PER_APP = 5;
export const DAILY_PROXY_REQUESTS = 10_000;
export const MAX_REQUEST_BODY_BYTES = 100 * 1024;
export const MAX_RESPONSE_BODY_BYTES = 100 * 1024;
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/; // uppercase + underscore convention

export type Ctx = Context<{ Bindings: Env }>;

/**
 * Wrap a handler so HttpError surfaces as a typed Response and the rest of
 * the routes don't need their own try/catch. Mirrors the pattern in apps.ts.
 */
export function wrap(handler: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx) => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
      if (err instanceof AllowlistError) return c.json({ error: err.message }, 400);
      throw err;
    }
  };
}

export function requireKek(c: Ctx): string {
  const kek = c.env.APP_SECRET_KEK;
  if (!kek) throw new HttpError('app-secret proxy not configured', 503);
  return kek;
}

export function toUint8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return new Uint8Array(0);
}
