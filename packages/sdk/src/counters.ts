import type { Auth } from './auth.js';

/**
 * Shared atomic counters — not user-scoped.
 * Any authenticated user can increment; anyone can read — except on a private
 * app (#259), where reads need a session the app admits too. Reads therefore
 * send the session whenever there is one (through same-origin mediation in
 * platform-cookie mode) and go anonymous only when signed out.
 * Use for: vote tallies, view counts, leaderboards.
 */
export class Counters {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /** A read: with the session when signed in (a private app needs it), anonymous otherwise. */
  private read(url: URL): Promise<Response> {
    return this.auth.isSignedIn ? this.auth.authenticatedFetch(url) : fetch(url);
  }

  /** Get all counters (or filter by prefix). No auth required on a public app; a private app needs a signed-in user it admits. */
  async list(opts?: { prefix?: string }): Promise<Record<string, number>> {
    const url = new URL(`/v1/apps/${encodeURIComponent(this.appId)}/counters`, this.apiBase);
    if (opts?.prefix) url.searchParams.set('prefix', opts.prefix);
    const response = await this.read(url);
    if (!response.ok) throw new Error(`counters.list failed: ${response.status}`);
    return (await response.json()) as Record<string, number>;
  }

  /** Get a single counter value. No auth required on a public app; a private app needs a signed-in user it admits. */
  async get(key: string): Promise<number> {
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/counters/${encodeURIComponent(key)}`,
      this.apiBase,
    );
    const response = await this.read(url);
    if (!response.ok) throw new Error(`counters.get failed: ${response.status}`);
    const data = (await response.json()) as { value: number };
    return data.value;
  }

  /** Increment (or decrement) a counter. Requires auth. Returns new value. */
  async increment(key: string, amount = 1): Promise<number> {
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/counters/${encodeURIComponent(key)}`,
      this.apiBase,
    );
    const response = await this.auth.authenticatedFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ increment: amount }),
    });
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) throw new Error(`counters.increment failed: ${response.status}`);
    const data = (await response.json()) as { value: number };
    return data.value;
  }
}
