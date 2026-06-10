interface AuthLike {
  token: string | null;
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface SmsSendResult {
  sent: number;
  failed: number;
}

/**
 * SMS — send text messages via the PAS API (Twilio-backed server-side).
 *
 * The platform owns the Twilio credentials; the app never sees them.
 * Only the app creator can send. Rate-limiting / abuse protection is
 * server-side. Numbers must be E.164 ("+15551234567").
 *
 * Use case: class reminders, OTP codes, no-show notifications. Pair with
 * `app.notifications` (Web Push) for in-browser delivery on the same event.
 */
export class SMS {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** Send an SMS to a single phone number (E.164). Caller must be app creator. */
  async send(to: string, message: string): Promise<SmsSendResult> {
    return this._send([to], message);
  }

  /** Send the same SMS to many recipients. Caller must be app creator. */
  async broadcast(numbers: string[], message: string): Promise<SmsSendResult> {
    return this._send(numbers, message);
  }

  private async _send(numbers: string[], message: string): Promise<SmsSendResult> {
    const res = await this.auth.authenticatedFetch(`${this.apiBase}/v1/sms/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appId: this.appId, to: numbers, message }),
    });

    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (res.status === 403) throw new Error('Only the app creator can send SMS.');
    if (res.status === 503) throw new Error('SMS is not configured on this platform.');
    if (!res.ok) throw new Error(`SMS send failed: ${res.status}`);

    return (await res.json()) as SmsSendResult;
  }
}
