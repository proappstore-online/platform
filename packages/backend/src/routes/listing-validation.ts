import { HttpError } from '../lib/auth.js';

export const HEX = /^#[0-9a-fA-F]{3,8}$/;
export const URL_LIKE = /^https?:\/\/.+/i;
export const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const HANDLE = /^[a-zA-Z0-9._-]{1,64}$/;
// Bluesky handles look like "alice.bsky.social" or "alice.example.com" —
// dot-separated DNS-ish identifier, conservative ASCII subset.
export const BLUESKY_HANDLE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

export const MAX_TAGLINE = 60;
export const MAX_LONG_DESC = 5000;
export const MAX_SCREENSHOTS = 8;

export function clean(v: unknown, max?: number, fieldName?: string): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (max && s.length > max) {
    // Don't silently truncate — API clients deserve to know their data is being
    // rejected. The form-side already enforces maxLength so well-behaved
    // browser submissions never hit this; this guards SDKs / curl / scripts.
    throw new HttpError(`${fieldName ?? 'field'} too long (max ${max} characters)`, 400);
  }
  return s;
}

export function urlOrNull(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  if (!URL_LIKE.test(s)) throw new HttpError('invalid URL', 400);
  return s;
}

export function emailOrNull(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  if (!EMAIL_LIKE.test(s)) throw new HttpError('invalid email', 400);
  return s;
}

export function hexOrNull(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  if (!HEX.test(s)) throw new HttpError('invalid color (must be #RGB, #RRGGBB, or #RRGGBBAA)', 400);
  return s;
}

export function handleOrNull(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  // Strip a leading @ if the user pasted one
  const stripped = s.startsWith('@') ? s.slice(1) : s;
  if (!HANDLE.test(stripped)) throw new HttpError('invalid handle', 400);
  return stripped;
}
