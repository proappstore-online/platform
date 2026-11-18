/**
 * Cloudflare Email Service as verified app email uses it (#566): the `send_email`
 * Workers binding (`env.EMAIL`, no API key) for sending, and helpers for the
 * Email Routing `email()` handler. Tests fake the binding; without it the feature
 * is inert (`email_not_configured`).
 *
 * `send()` has no idempotency key, so the platform's own (app, idempotencyKey)
 * record is the only guard against a double send (lib/app-email.ts). An error that
 * means "not sent" is retryable; one that leaves the outcome unknown is not retried.
 */
import type { EmailSendingBinding, EmailSendMessage } from '../types.js';

/** Errors that mean Cloudflare did NOT send: safe to try again under the same key. */
const NOT_SENT = new Set(['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_EMAIL_SENDING_NOT_READY']);

export type ProviderFailure = 'busy' | 'unknown' | 'suppressed' | 'rejected';

/** `send()` threw. `kind` says what the platform may assume about the message. */
export class EmailProviderError extends Error {
  constructor(readonly kind: ProviderFailure, readonly providerCode: string) {
    super(`email provider: ${providerCode}`);
  }
}

/** The provider message id; the same id names the message in delivery events. */
export async function sendMessage(binding: EmailSendingBinding, message: EmailSendMessage): Promise<string> {
  try {
    const out = await binding.send(message);
    if (typeof out?.messageId !== 'string' || !out.messageId) throw new EmailProviderError('unknown', 'NO_MESSAGE_ID');
    return out.messageId;
  } catch (e) {
    if (e instanceof EmailProviderError) throw e;
    const code = (e as { code?: unknown })?.code;
    // A TypeError has no code: our payload was malformed, nothing was sent.
    if (typeof code !== 'string') throw new EmailProviderError(e instanceof TypeError ? 'rejected' : 'unknown', e instanceof TypeError ? 'E_TYPE' : 'E_UNCODED');
    if (code === 'E_RECIPIENT_SUPPRESSED') throw new EmailProviderError('suppressed', code);
    if (NOT_SENT.has(code)) throw new EmailProviderError('busy', code);
    if (code === 'E_INTERNAL_SERVER_ERROR') throw new EmailProviderError('unknown', code);
    throw new EmailProviderError('rejected', code);
  }
}

export interface AuthResults { spf: string; dkim: string; dmarc: string }

/**
 * SPF, DKIM and DMARC as Email Routing recorded them. Only a leading
 * `Authentication-Results` header from authserv-id `mx.cloudflare.net` counts: a header the
 * sender wrote cannot be trusted. Null when there is none.
 */
export function cloudflareAuthResults(headers: Headers): AuthResults | null {
  const value = headers.get('authentication-results')?.trim();
  if (!value || !/^mx\.cloudflare\.net\s*(;|$)/i.test(value)) return null;
  const first = value.split(/;\s*mx\.cloudflare\.net/i)[0]!; // never read past a second, sender-supplied header folded in
  const get = (name: string) => new RegExp(`(?:^|[;\\s])${name}=([a-z]+)`, 'i').exec(first)?.[1]?.toLowerCase() ?? 'unknown';
  return { spf: get('spf'), dkim: get('dkim'), dmarc: get('dmarc') };
}
