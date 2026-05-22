/**
 * Transactional email sender — Resend HTTPS API.
 *
 * Vendored from FAS (fas/platform/packages/backend/src/lib/email.ts).
 * Resend has a generous free tier (3k/mo, 100/day) plus a JSON API that
 * works in Workers without an SDK.
 *
 * Set `RESEND_API_KEY` and `EMAIL_FROM` (e.g. "ProAppStore <noreply@proappstore.online>")
 * as Worker secrets. If `RESEND_API_KEY` is unset, send() throws — routes
 * that depend on email should 503 in that case.
 */

export interface SendEmailOpts {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface EmailConfig {
  apiKey: string;
  from: string;
}

export async function sendEmail(cfg: EmailConfig, opts: SendEmailOpts): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: cfg.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      ...(opts.replyTo && { reply_to: opts.replyTo }),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend send failed: ${res.status} ${body}`);
  }
}

/** Normalize for storage + dedup: trim + lowercase. No validation here. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Minimal RFC 5322-ish validation. Cheaper than a full parser; good enough for a gate. */
export function isLikelyEmail(email: string): boolean {
  if (email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
