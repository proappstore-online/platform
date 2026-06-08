import type { Unsubscribe, User } from './base-types.js';

export type AuthProvider = 'github' | 'google' | 'email';

/** PAS-owned localStorage key for the cached session (per-origin). */
const STORAGE_KEY = 'pas:session';

/** Hash param the PAS auth service returns the session in (routes/auth.ts). */
const SESSION_HASH = '#pas_session=';

interface Session {
  token: string;
  user: User;
}

/** OAuth authentication — sign in, sign out, session management. */
export class Auth {
  private session: Session | null = null;
  private listeners = new Set<(user: User | null) => void>();
  private lastAuthError: string | null = null;

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
  ) {
    this.session = this.readStorage();
    if (this.session) this.ensureMember();
  }

  /** Current signed-in user, or null if not authenticated. */
  get user(): User | null {
    return this.session?.user ?? null;
  }

  /**
   * Reason the last sign-in failed (e.g. 'access_denied', 'profile_fetch_failed'),
   * captured from the `#auth_error=` callback hash by init(); null if none.
   */
  get authError(): string | null {
    return this.lastAuthError;
  }

  /** Current session token, or null if not authenticated. */
  get token(): string | null {
    return this.session?.token ?? null;
  }

  /** Subscribe to auth state changes. Fires immediately with current user, then on every change. */
  onChange(listener: (user: User | null) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.user);
    return () => this.listeners.delete(listener);
  }

  /**
   * Redirect-based GitHub OAuth. Opens the platform's hosted OAuth start URL,
   * which redirects back to the current page with a session token in the hash.
   *
   * The current page's `location.hash` is dropped from `return_to` because
   * the OAuth callback writes its own session hash and would clobber any
   * hash-based router state otherwise.
   */
  signIn(provider: AuthProvider = 'github'): void {
    if (typeof window === 'undefined') return;
    if (provider === 'email') {
      throw new Error('Use signInWithEmail(email) for email magic-link sign-in.');
    }
    const here = new URL(window.location.href);
    here.hash = '';
    const url = new URL(`/v1/auth/${provider}/start`, this.apiBase);
    url.searchParams.set('app_id', this.appId);
    url.searchParams.set('return_to', here.toString());
    window.location.assign(url.toString());
  }

  /**
   * Email magic-link sign-in. Sends the user an email with a one-time link
   * that completes auth and redirects back here with the session hash.
   *
   * Resolves once the email has been queued. The caller should show a
   * "check your inbox" message — the actual sign-in happens later when
   * the user clicks the link.
   *
   * Throws on validation or server errors. Resolves with `{ ok: true }`
   * regardless of whether the email is already registered (no account-
   * enumeration leak).
   */
  async signInWithEmail(email: string): Promise<void> {
    if (typeof window === 'undefined') return;
    const here = new URL(window.location.href);
    here.hash = '';
    const res = await fetch(new URL('/v1/auth/email/start', this.apiBase), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, appId: this.appId, returnTo: here.toString() }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Magic-link request failed: ${res.status} ${body}`);
    }
  }

  /**
   * Sign in with a provisioned username + password (no email, no OAuth).
   * These accounts are created by an adult via {@link provisionChild} — built
   * for students/children who don't have email. On success the platform mints
   * a normal PAS session and this stores it exactly like the OAuth flow, so
   * `app.db`, `app.rooms`, roles, etc. all work unchanged.
   *
   * @throws if the credentials are invalid (401) or rate-limited (429).
   */
  async signInWithCredentials(login: string, password: string): Promise<User> {
    const res = await fetch(new URL('/v1/auth/credentials/login', this.apiBase), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('Invalid login or password.');
      if (res.status === 429) throw new Error('Too many sign-in attempts — please try again later.');
      throw new Error(`Sign-in failed (${res.status}): ${body}`);
    }
    const { token } = (await res.json()) as { token: string };
    const user = await this.fetchUser(token);
    this.session = { token, user };
    this.lastAuthError = null;
    if (typeof window !== 'undefined') this.writeStorage(this.session);
    this.emit();
    this.ensureMember();
    return user;
  }

  /**
   * Provision a child/student credential account. Requires the *current* user
   * to be signed in as a creator (adult). Returns the generated `login` and
   * `password` ONCE — the password is never retrievable again, so surface it
   * to the adult immediately (copy/print) and let them re-provision if lost.
   *
   * Pass `login` to choose the username (else an `animal-animal-animal` triple
   * is generated), `displayName` for a friendly display handle, and `isChild`
   * (defaults to true). The provisioned account does NOT replace the current
   * session — the adult stays signed in.
   *
   * @throws if not signed in as a creator (403) or the login is taken (409).
   */
  async provisionChild(
    opts: { login?: string; displayName?: string; isChild?: boolean; password?: string } = {},
  ): Promise<{ uid: string; login: string; password: string; isChild: boolean }> {
    if (!this.session) throw new Error('Not signed in.');
    const res = await fetch(new URL('/v1/auth/credentials/provision', this.apiBase), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(opts),
    });
    if (res.status === 401) {
      this.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 403) throw new Error('Only creators can provision accounts.');
      if (res.status === 409) throw new Error('That login is already taken.');
      throw new Error(`Provision failed (${res.status}): ${body}`);
    }
    return (await res.json()) as { uid: string; login: string; password: string; isChild: boolean };
  }

  /**
   * Reset the password for a credential (child) account. Returns the new
   * random password ONCE — show it to the student immediately. Only callable
   * by a signed-in creator (teacher/admin). The old password is invalidated.
   */
  async resetPassword(targetUserId: string): Promise<{ password: string }> {
    if (!this.session) throw new Error('Not signed in.');
    const res = await fetch(new URL('/v1/auth/credentials/reset-password', this.apiBase), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetUserId }),
    });
    if (res.status === 401) {
      this.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Reset failed (${res.status}): ${body}`);
    }
    return (await res.json()) as { password: string };
  }

  /** Clear the session and notify listeners. */
  signOut(): void {
    this.session = null;
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    this.emit();
  }

  /**
   * @internal Called by Kv and ApiProxy on 401 responses.
   * Clears the stale session so the UI reacts immediately.
   * Do not call directly — use `signOut()` instead.
   */
  handleUnauthorized(): void {
    if (this.session) this.signOut();
  }

  /**
   * Call this once at app start, before rendering anything that depends on
   * auth state. If the page was loaded via an auth callback (e.g. after
   * `signIn()` returned from GitHub), this captures the session from the
   * URL hash, persists it to localStorage, and clears the hash. On a normal
   * page load it's a no-op — the constructor already restored any cached
   * session from localStorage.
   *
   * @example
   *   const app = initPro({ appId: 'my-app' });
   *   await app.auth.init();
   *   render();
   */
  async init(): Promise<void> {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;

    // A failed sign-in bounces back with `#auth_error=<reason>` — record it and
    // clear the hash so the user isn't stuck on a broken URL or stuck retrying.
    if (hash.startsWith('#auth_error=')) {
      try { this.lastAuthError = decodeURIComponent(hash.slice('#auth_error='.length)) || 'unknown'; } catch { this.lastAuthError = 'unknown'; }
      history.replaceState(null, '', window.location.pathname + window.location.search);
      return;
    }

    if (!hash.startsWith(SESSION_HASH)) return;

    // Always clear the hash before doing anything else — even on failure.
    // Otherwise a bad token gets re-tried on every reload and the user is
    // permanently stuck on a "broken" URL.
    history.replaceState(null, '', window.location.pathname + window.location.search);

    let token: string;
    try {
      token = decodeURIComponent(hash.slice(SESSION_HASH.length));
    } catch {
      // Malformed hash (% with nothing after, etc.). Hash already cleared.
      return;
    }
    if (!token) return;

    try {
      const user = await this.fetchUser(token);
      this.session = { token, user };
      this.writeStorage(this.session);
      this.emit();
      this.ensureMember();
    } catch {
      // Token was invalid or network failed. Hash already cleared so the user
      // won't get stuck in a retry loop. Silently remain signed out.
    }
  }

  /**
   * Set the user's platform-level date of birth. Set-once: throws if it's
   * already set (status 409 from the backend) or if age < 13. After success
   * the cached user is updated and listeners are notified.
   *
   * @param dateOfBirth ISO 'YYYY-MM-DD' string.
   */
  async setDateOfBirth(dateOfBirth: string): Promise<User> {
    if (!this.session) throw new Error('Not signed in.');
    const response = await fetch(new URL('/v1/auth/me/date-of-birth', this.apiBase), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dateOfBirth }),
    });
    if (response.status === 401) {
      this.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (response.status === 409) {
      throw new Error('Date of birth already set.');
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`setDateOfBirth failed (${response.status}): ${body}`);
    }
    const user = (await response.json()) as User;
    this.session = { ...this.session, user };
    this.writeStorage(this.session);
    this.emit();
    return user;
  }

  private async fetchUser(token: string): Promise<User> {
    const response = await fetch(new URL('/v1/auth/me', this.apiBase), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Auth failed: ${response.status}`);
    const data = (await response.json()) as User;
    // Ensure `name` is always populated (API returns `login`)
    if (!data.name) data.name = data.login;
    return data;
  }

  /** Fire-and-forget: ensure the user has at least 'member' role in this app. */
  private ensureMember(): void {
    if (typeof fetch === 'undefined') return; // SSR / test env
    const t = this.session?.token;
    if (!t) return;
    fetch(`${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/roles/ensure-member`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}` },
    }).catch(() => {}); // silent — non-blocking
  }

  private readStorage(): Session | null {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const session = JSON.parse(raw) as Session;
      // Backfill `name` for sessions cached before the field was added
      if (session.user && !session.user.name) session.user.name = session.user.login;
      return session;
    } catch {
      return null;
    }
  }

  private writeStorage(session: Session): void {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.user);
  }
}
