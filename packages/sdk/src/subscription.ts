import type { CheckoutRequest, Subscription } from './types.js';

interface AuthLike {
  token: string | null;
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export class SubscriptionApi {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** Returns the user's current subscription, or null if they have none. */
  async status(): Promise<Subscription | null> {
    const response = await this.req('GET', '/v1/subscription');
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`subscription.status failed: ${response.status}`);
    return (await response.json()) as Subscription;
  }

  /** Redirects to Stripe-hosted checkout. Page navigates away. */
  async openCheckout(req: CheckoutRequest): Promise<void> {
    const response = await this.req('POST', '/v1/checkout', req);
    if (!response.ok) throw new Error(`subscription.openCheckout failed: ${response.status}`);
    const { url } = (await response.json()) as { url: string };
    if (typeof window !== 'undefined') window.location.assign(url);
  }

  /** Redirects to Stripe customer portal to manage billing. */
  async openPortal(returnUrl: string): Promise<void> {
    const response = await this.req('POST', '/v1/portal', { returnUrl });
    if (!response.ok) throw new Error(`subscription.openPortal failed: ${response.status}`);
    const { url } = (await response.json()) as { url: string };
    if (typeof window !== 'undefined') window.location.assign(url);
  }

  private async req(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.auth.authenticatedFetch(new URL(path, this.apiBase), init);
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    return response;
  }
}
