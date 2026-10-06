/**
 * Body encoding for JSON envelopes (ADR-009 §3): `utf8` when the content type
 * is textual and the bytes are valid UTF-8, otherwise `base64`, so the other
 * side can rebuild the exact bytes. Shared by inbound hooks (#256), browser
 * http events (#260) and the shim that wraps a worker's http response.
 * Dependency-free: it is bundled into the shim.
 */
const TEXTUAL = /^(text\/[^;]+|application\/json|application\/[^;]+\+json|application\/x-www-form-urlencoded)\s*(;|$)/i;

export type BodyEncoding = 'utf8' | 'base64';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function encodeEnvelopeBody(body: Uint8Array, contentType: string | null): { body: string; body_encoding: BodyEncoding } {
  if (contentType && TEXTUAL.test(contentType.trim())) {
    try {
      return { body: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), body_encoding: 'utf8' };
    } catch { /* not UTF-8 after all */ }
  }
  return { body: toBase64(body), body_encoding: 'base64' };
}

export function decodeEnvelopeBody(body: unknown, encoding: unknown): Uint8Array {
  const text = typeof body === 'string' ? body : '';
  if (encoding !== 'base64') return new TextEncoder().encode(text);
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
