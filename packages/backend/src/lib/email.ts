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
  /** Extra message headers, e.g. List-Unsubscribe (#209). */
  headers?: Record<string, string>;
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
      ...(opts.headers && { headers: opts.headers }),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend send failed: ${res.status} ${body}`);
  }
}

/**
 * Normalize an email for storage/lookup/dedup: trim + lowercase. No validation here.
 *
 * Lowercasing the local part is technically lossy — RFC 5321 lets `A@x.com`
 * and `a@x.com` be different mailboxes — but no provider anyone signs in with
 * treats them that way, and the unique index in 0042 is byte-wise, so the
 * alternative is two separately-loginable rows for one human's address.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Minimal RFC 5322-ish validation. Cheaper than a full parser; good enough for a gate. */
export function isLikelyEmail(email: string): boolean {
  if (email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
