import type { Auth } from './auth.js';

/**
 * Shared atomic counters — not user-scoped.
 * Any authenticated user can increment; anyone can read.
 * Use for: vote tallies, view counts, leaderboards.
 */
export class Counters {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /** Get all counters (or filter by prefix). Public — no auth required. */
  async list(opts?: { prefix?: string }): Promise<Record<string, number>> {
    const url = new URL(`/v1/apps/${encodeURIComponent(this.appId)}/counters`, this.apiBase);
    if (opts?.prefix) url.searchParams.set('prefix', opts.prefix);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`counters.list failed: ${response.status}`);
    return (await response.json()) as Record<string, number>;
  }

  /** Get a single counter value. Public — no auth required. */
  async get(key: string): Promise<number> {
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/counters/${encodeURIComponent(key)}`,
      this.apiBase,
    );
    const response = await fetch(url);
    if (!response.ok) throw new Error(`counters.get failed: ${response.status}`);
    const data = (await response.json()) as { value: number };
    return data.value;
  }

  /** Increment (or decrement) a counter. Requires auth. Returns new value. */
  async increment(key: string, amount = 1): Promise<number> {
    if (!this.auth.token) throw new Error('Not signed in.');
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/counters/${encodeURIComponent(key)}`,
      this.apiBase,
    );
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.auth.token}`,
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
