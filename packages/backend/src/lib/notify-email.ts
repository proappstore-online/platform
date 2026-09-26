/**
 * The email channel of notify-user (#209): the platform resolves a member's
 * verified address and sends a fixed template, so an app can reach its users by
 * email without ever seeing an address or supplying HTML.
 */

/** HMAC domain separation: this key signs sessions too, never the same message. */
const UNSUBSCRIBE_DOMAIN = 'notify-user-unsubscribe:';

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** A per-(app, user) unsubscribe token: `<payload>.<hmac>`, both base64url. */
export async function signUnsubscribeToken(secret: string, appId: string, userId: string): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify({ a: appId, u: userId }));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(UNSUBSCRIBE_DOMAIN + b64url(payload)));
  return `${b64url(payload)}.${b64url(new Uint8Array(sig))}`;
}

/** The (app, user) a token was minted for, or null if it is malformed or forged. */
export async function verifyUnsubscribeToken(secret: string, token: string): Promise<{ appId: string; userId: string } | null> {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), new TextEncoder().encode(UNSUBSCRIBE_DOMAIN + payload));
    if (!ok) return null;
    const { a, u } = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { a?: unknown; u?: unknown };
    return typeof a === 'string' && typeof u === 'string' ? { appId: a, userId: u } : null;
  } catch {
    return null;
  }
}

/**
 * Whether `url` is on the app's own origin: its platform subdomain or one of its
 * active custom domains (exact match). Only these may be linked from an email.
 */
export async function isAppOriginUrl(db: D1Database, appId: string, url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === `${appId}.proappstore.online`) return true;
  const row = await db
    .prepare("SELECT 1 FROM app_custom_domains WHERE app_id = ?1 AND domain = ?2 AND status = 'active' LIMIT 1")
    .bind(appId, host)
    .first();
  return row !== null;
}

const html = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The fixed notify-user template: app name + title as subject, escaped text, a same-origin link, an unsubscribe link. */
export function renderNotifyEmail(opts: { appId: string; title: string; body: string; link: string; unsubscribeUrl: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const { appId, title, body, link, unsubscribeUrl } = opts;
  const subject = `${appId}: ${title}`.replace(/[\r\n]+/g, ' ');
  const footer = `You received this because you use ${appId} on ProAppStore.`;
  return {
    subject,
    text: `${title}\n\n${body}\n\nOpen ${appId}: ${link}\n\n--\n${footer}\nUnsubscribe from ${appId} emails: ${unsubscribeUrl}\n`,
    html:
      `<h2 style="font-size:18px">${html(title)}</h2>` +
      `<p style="white-space:pre-wrap">${html(body)}</p>` +
      `<p><a href="${html(link)}">Open ${html(appId)}</a></p>` +
      `<hr><p style="font-size:12px;color:#666">${html(footer)} ` +
      `<a href="${html(unsubscribeUrl)}">Unsubscribe from ${html(appId)} emails</a>.</p>`,
  };
}
