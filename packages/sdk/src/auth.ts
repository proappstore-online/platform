import type { Unsubscribe, User } from './base-types.js';

export type AuthProvider = 'github' | 'google' | 'email';
export type AuthMode = 'legacy-bearer' | 'platform-cookie';

/** PAS-owned localStorage key for the legacy cached session (per-origin). */
const STORAGE_KEY = 'pas:session';

/** Hash param the PAS auth service returns the session in (routes/auth.ts). */
const SESSION_HASH = '#pas_session=';

interface Session {
  token: string | null;
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
    private readonly authMode: AuthMode = 'legacy-bearer',
  ) {
    this.session = this.authMode === 'legacy-bearer' ? this.readStorage() : null;
    if (this.session) this.ensureMember();
  }

  /** Current signed-in user, or null if not authenticated. */
  get user(): User | null {
    return this.session?.user ?? null;
  }

  /** True when the SDK has a current authenticated user. */
  get isSignedIn(): boolean {
    return this.session !== null;
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
    return this.authMode === 'legacy-bearer' ? this.session?.token ?? null : null;
  }

  /** True when this SDK instance uses PAS-hosted HttpOnly cookie sessions. */
  get usesPlatformCookie(): boolean {
    return this.authMode === 'platform-cookie';
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
    if (this.authMode === 'platform-cookie') {
      const url = new URL('/.pas/auth/start', here.origin);
      url.searchParams.set('provider', provider);
      url.searchParams.set('return_to', `${here.pathname}${here.search}`);
      window.location.assign(url.toString());
      return;
    }
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
    if (this.authMode === 'platform-cookie') {
      throw new Error('Email magic-link sign-in is not available in platform-cookie mode yet.');
    }
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
    if (this.authMode === 'platform-cookie') {
      throw new Error('Credential sign-in is not available in platform-cookie mode yet.');
    }
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
    const res = await this.authenticatedFetch(new URL('/v1/auth/credentials/provision', this.apiBase), {
      method: 'POST',
      headers: {
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
    const res = await this.authenticatedFetch(new URL('/v1/auth/credentials/reset-password', this.apiBase), {
      method: 'POST',
      headers: {
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

  /**
   * Change the password for the currently signed-in credential account.
   * Requires the current password for verification. Only callable by
   * credential (child/student) accounts — OAuth users don't have passwords.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const res = await this.authenticatedFetch(new URL('/v1/auth/credentials/change-password', this.apiBase), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (res.status === 401) {
      this.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = (() => { try { return JSON.parse(body).error; } catch { return ''; } })();
      throw new Error(msg || `Password change failed (${res.status})`);
    }
  }

  /** Clear the session and notify listeners. */
  signOut(): void {
    this.session = null;
    if (this.authMode === 'platform-cookie') {
      if (typeof fetch !== 'undefined') {
        fetch('/.pas/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      }
    } else {
      this.clearStorage();
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
   * URL hash, persists it to browser storage when available, and clears the
   * hash. On a normal page load it's a no-op — the constructor already
   * restored any cached session from storage if the browser allowed it.
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

    if (this.authMode === 'platform-cookie') {
      if (hash.startsWith(SESSION_HASH)) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      await this.hydratePlatformCookieSession();
      return;
    }

    if (!hash.startsWith(SESSION_HASH)) {
      // Cross-subdomain restoration may only have the token. Hydrate the user
      // before auth listeners render the app as signed out.
      if (this.session?.token && !this.session.user) {
        try {
          const user = await this.fetchUser(this.session.token);
          this.session = { ...this.session, user };
          this.writeStorage(this.session);
          this.emit();
          this.ensureMember();
        } catch {
          this.signOut();
        }
      }
      return;
    }

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
    const response = await this.authenticatedFetch(new URL('/v1/auth/me/date-of-birth', this.apiBase), {
      method: 'PATCH',
      headers: {
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
    this.session = { token: this.authMode === 'legacy-bearer' ? this.session?.token ?? null : null, user };
    if (this.authMode === 'legacy-bearer') this.writeStorage(this.session);
    this.emit();
    return user;
  }

  /** Authenticated platform request. In cookie mode this goes through same-origin PAS mediation. */
  async authenticatedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    if (!this.session) throw new Error('Not signed in.');
    const target = this.authMode === 'platform-cookie' ? this.platformMediatedUrl(input) : input;
    const headers = new Headers(init.headers);
    if (this.authMode === 'legacy-bearer') {
      const token = this.session.token;
      if (!token) throw new Error('Not signed in.');
      headers.set('Authorization', `Bearer ${token}`);
    }
    const requestInit: RequestInit = {
      ...init,
      headers,
    };
    if (this.authMode === 'platform-cookie') requestInit.credentials = 'same-origin';
    const response = await fetch(target, requestInit);
    if (response.status === 401) this.handleUnauthorized();
    return response;
  }

  private async hydratePlatformCookieSession(): Promise<void> {
    try {
      const response = await fetch('/.pas/auth/me', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        this.session = null;
        this.emit();
        return;
      }
      const user = normalizeUser((await response.json()) as User);
      this.session = { token: null, user };
      this.lastAuthError = null;
      this.emit();
      this.ensureMember();
    } catch {
      this.session = null;
      this.emit();
    }
  }

  private platformMediatedUrl(input: string | URL): string {
    const raw = input.toString();
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://app.local';
    const target = new URL(raw, base);
    const api = new URL(this.apiBase);
    if (target.origin === api.origin) return `/.pas/api${target.pathname}${target.search}`;
    const appData = new URL(`https://data-${this.appId}.proappstore.online`);
    if (target.origin === appData.origin) return `/.pas/data${target.pathname}${target.search}`;
    if (target.origin === base) return `${target.pathname}${target.search}`;
    return raw;
  }

  private async fetchUser(token: string): Promise<User> {
    const response = await fetch(new URL('/v1/auth/me', this.apiBase), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Auth failed: ${response.status}`);
    return normalizeUser((await response.json()) as User);
  }

  /** Fire-and-forget: ensure the user has at least 'member' role in this app. */
  private ensureMember(): void {
    if (typeof fetch === 'undefined') return; // SSR / test env
    if (!this.session) return;
    this.authenticatedFetch(`${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/roles/ensure-member`, {
      method: 'POST',
    }).catch(() => {}); // silent — non-blocking
  }

  private readStorage(): Session | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw) as Session;
      // Backfill `name` for sessions cached before the field was added
      if (session.user && !session.user.name) session.user.name = session.user.login;
      return session;
    } catch {
      return null;
    }
  }

  private writeStorage(session: Session): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Some browsers/privacy modes expose localStorage but throw on access.
      // Keep the already-validated session in memory for this page lifetime.
    }
  }

  private clearStorage(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Sign-out must still clear the in-memory session even when storage is
      // blocked or corrupted.
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.user);
  }
}

function normalizeUser(data: User): User {
  if (!data.login) data.login = data.name || data.id;
  if (!data.name) data.name = data.login || data.id;
  return data;
}
