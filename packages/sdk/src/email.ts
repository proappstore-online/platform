interface AuthLike {
  token: string | null;
  handleUnauthorized(): void;
}

/**
 * Transactional email — send emails via the PAS API (Resend-backed server-side).
 *
 * The platform owns the Resend credentials; the app never sees them.
 * Only app owners and editors can send. Rate-limited to 100/day per app.
 */
export class Email {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** Send a transactional email. Caller must be app owner or editor. */
  async send(
    to: string,
    subject: string,
    body: string,
    opts?: { replyTo?: string },
  ): Promise<void> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');

    const res = await fetch(`${this.apiBase}/v1/email/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: this.appId,
        to,
        subject,
        body,
        replyTo: opts?.replyTo,
      }),
    });

    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (res.status === 403) throw new Error('Not authorized to send email for this app.');
    if (res.status === 429) throw new Error('Daily email limit reached.');
    if (res.status === 503) throw new Error('Email is not configured on this platform.');
    if (!res.ok) throw new Error(`Email send failed: ${res.status}`);
  }
}
