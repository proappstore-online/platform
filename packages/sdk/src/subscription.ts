import type { CheckoutRequest, Subscription } from './types.js';

export class SubscriptionApi {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly token: () => string | null,
  ) {}

  /** Returns the user's current subscription, or null if they have none. */
  async status(): Promise<Subscription | null> {
    const res = await this.req('GET', '/v1/subscription');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`subscription.status failed: ${res.status}`);
    return (await res.json()) as Subscription;
  }

  /**
   * Redirects the user to a Stripe-hosted checkout for the given price.
   * Returns nothing — the page navigates away.
   */
  async openCheckout(req: CheckoutRequest): Promise<void> {
    const res = await this.req('POST', '/v1/checkout', req);
    if (!res.ok) throw new Error(`subscription.openCheckout failed: ${res.status}`);
    const { url } = (await res.json()) as { url: string };
    window.location.assign(url);
  }

  /** Redirects the user to the Stripe customer portal to manage billing. */
  async openPortal(returnUrl: string): Promise<void> {
    const res = await this.req('POST', '/v1/portal', { returnUrl });
    if (!res.ok) throw new Error(`subscription.openPortal failed: ${res.status}`);
    const { url } = (await res.json()) as { url: string };
    window.location.assign(url);
  }

  private async req(method: string, path: string, body?: unknown): Promise<Response> {
    const token = this.token();
    if (!token) throw new Error('Not signed in. Pass fas.auth.token to initPro().');
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(new URL(path, this.apiBase), init);
  }
}
