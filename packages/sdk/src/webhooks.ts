interface AuthLike {
  token: string | null;
  handleUnauthorized(): void;
}

export interface WebhookConfig {
  id: string;
  event: string;
  url: string;
  active: number;
  created_at: number;
}

export interface WebhookTestResult {
  status: number;
  body: string;
}

/**
 * Outbound webhooks — register URLs to receive signed event payloads.
 *
 * Events are delivered via POST with HMAC-SHA256 signature in
 * `X-Webhook-Signature` header. The signing secret is returned once
 * on registration.
 */
export class Webhooks {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** List all registered webhooks for this app. */
  async list(): Promise<WebhookConfig[]> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');

    const appId = encodeURIComponent(this.appId);
    const res = await fetch(`${this.apiBase}/v1/apps/${appId}/webhooks`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) throw new Error(`Failed to list webhooks: ${res.status}`);
    const data = (await res.json()) as { webhooks: WebhookConfig[] };
    return data.webhooks;
  }

  /** Register a new webhook. Returns the ID and signing secret. */
  async register(event: string, url: string): Promise<{ id: string; secret: string }> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');

    const appId = encodeURIComponent(this.appId);
    const res = await fetch(`${this.apiBase}/v1/apps/${appId}/webhooks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event, url }),
    });

    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) throw new Error(`Failed to register webhook: ${res.status}`);
    return (await res.json()) as { id: string; secret: string };
  }

  /** Remove a registered webhook. */
  async remove(id: string): Promise<void> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');

    const appId = encodeURIComponent(this.appId);
    const res = await fetch(`${this.apiBase}/v1/apps/${appId}/webhooks/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) throw new Error(`Failed to remove webhook: ${res.status}`);
  }

  /** Fire a test event to a registered webhook and return the response. */
  async test(id: string): Promise<WebhookTestResult> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');

    const appId = encodeURIComponent(this.appId);
    const res = await fetch(`${this.apiBase}/v1/apps/${appId}/webhooks/${id}/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) throw new Error(`Failed to test webhook: ${res.status}`);
    return (await res.json()) as WebhookTestResult;
  }
}
