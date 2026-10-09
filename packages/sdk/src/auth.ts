import type { Unsubscribe, User } from './base-types.js';
import type { AuthTelemetryEvent } from './logs.js';

export type AuthProvider = 'github' | 'google' | 'email';
export type AuthMode = 'legacy-bearer' | 'platform-cookie';

/**
 * Where the SDK is in knowing who the user is (#241).
 *
 * - `pending`: not known yet. With the platform cookie the user is only known
 *   once `/.pas/auth/me` answers; a legacy page may still be capturing a
 *   `#pas_session=` callback. Render a neutral loading state — never the
 *   signed-out UI.
 * - `signed-in`: there is a user.
 * - `signed-out`: known to have no user — auth resolved without one, the user
 *   signed out, or an expired session was cleared (a 401 signs out).
 */
export type AuthStatus = 'pending' | 'signed-in' | 'signed-out';

/** `<meta name>` the PAS host stamps on every page it serves (host meta-rewriter). */
export const AUTH_MODE_META_NAME = 'pas-auth-mode';

/**
 * Pick the auth mode when the app did not set one (#20).
 *
 * `platform-cookie` only works on an origin the PAS host worker serves, because
 * that is where the `/.pas/auth/*` and `/.pas/api|data/*` routes live. The
 * host marks those pages with `<meta name="pas-auth-mode" content="platform-cookie">`,
 * so the marker — not the hostname — decides. Anything else (localhost, a
 * Pages-hosted first-party site, SSR, tests) stays `legacy-bearer`. An
 * explicit `authMode` always wins.
 */
export function resolveAuthMode(explicit?: AuthMode): AuthMode {
  if (explicit) return explicit;
  const doc = (globalThis as { document?: { querySelector?: (selector: string) => { getAttribute(name: string): string | null } | null } }).document;
  try {
    const content = doc?.querySelector?.(`meta[name="${AUTH_MODE_META_NAME}"]`)?.getAttribute('content');
    return content === 'platform-cookie' ? 'platform-cookie' : 'legacy-bearer';
  } catch {
    return 'legacy-bearer';
  }
}

/** `<meta name>` the PAS host stamps on a PRIVATE app's pages (#259, host meta-rewriter). */
export const VISIBILITY_META_NAME = 'pas-visibility';

/**
 * Whether this app is private (#259). An explicit `visibility` option wins;
 * otherwise the host's `<meta name="pas-visibility" content="private">` decides
 * (the host strips any copy an app ships). No document → public.
 */
export function resolvePrivateApp(explicit?: 'public' | 'private'): boolean {
  if (explicit) return explicit === 'private';
  const doc = (globalThis as { document?: { querySelector?: (selector: string) => { getAttribute(name: string): string | null } | null } }).document;
  try {
    return doc?.querySelector?.(`meta[name="${VISIBILITY_META_NAME}"]`)?.getAttribute('content') === 'private';
  } catch {
    return false;
  }
}

/** PAS-owned localStorage key for the legacy cached session (per-origin). */
const STORAGE_KEY = 'pas:session';

/** Hash param the PAS auth service returns the session in (routes/auth.ts). */
const SESSION_HASH = '#pas_session=';

interface Session {
  token: string | null;
  user: User;
}

interface AuthTelemetryReporter {
  captureAuthEvent(event: AuthTelemetryEvent): void;
}

interface InvalidationContext {
  reason: 'api_401' | 'legacy_session_rejected';
  phase: 'api_request' | 'cookie_hydration' | 'legacy_hydration';
  route: 'platform.api' | 'auth.me';
  correlationId: string;
  status?: number;
}

const INVALIDATION_ID_HEADER = 'X-PAS-Session-Invalidation-Id';
const INVALIDATION_REASON_HEADER = 'X-PAS-Session-Invalidation-Reason';
const CORRELATION_ID_RE = /^[a-f0-9]{32}$/i;

/** OAuth authentication — sign in, sign out, session management. */
/** Options for {@link Auth.register}. */
export interface RegisterOptions {
  /** Token from the Turnstile widget rendered with {@link Auth.turnstileSiteKey} (#26). Required when the platform enforces the bot check. */
  turnstileToken?: string;
}

export class Auth {
  private session: Session | null = null;
  private listeners = new Set<(user: User | null) => void>();
  private statusListeners = new Set<(status: AuthStatus, user: User | null) => void>();
  private lastAuthError: string | null = null;
  /** True once the SDK has an answer about the user: init() settled, or an explicit sign-out. */
  private resolved = false;
  private initializing: Promise<void> | null = null;
  /** init() has run to completion once on this page. */
  private initialized = false;
  private reporter: AuthTelemetryReporter | null = null;
  private sessionStartedAt = Date.now();

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly authMode: AuthMode = 'legacy-bearer',
  ) {
    this.session = this.authMode === 'legacy-bearer' ? this.readStorage() : null;
    // A cached session that names its user is already an answer; a token-only
    // restore (or the platform cookie) is not until init() has hydrated it.
    this.resolved = Boolean(this.session?.user);
    if (this.session) this.ensureMember();
  }

  /** Where the SDK is in knowing who the user is. Render nothing signed-out while this is `pending`. */
  get status(): AuthStatus {
    if (this.session?.user) return 'signed-in';
    return this.resolved ? 'signed-out' : 'pending';
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

  /** @internal Wired by ProAppStore after its existing Logs instance is created. */
  setTelemetryReporter(reporter: AuthTelemetryReporter): void {
    this.reporter = reporter;
  }

  /**
   * Subscribe to auth state changes. Fires immediately with current user, then on every change.
   * A `null` user may still be `pending` (not yet known): gate UI on {@link onStatus} instead.
   */
  onChange(listener: (user: User | null) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.user);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to the auth status and user (#241). Fires immediately, then whenever
   * either changes — including the move from `pending` to a resolved state.
   */
  onStatus(listener: (status: AuthStatus, user: User | null) => void): Unsubscribe {
    this.statusListeners.add(listener);
    listener(this.status, this.user);
    return () => this.statusListeners.delete(listener);
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
    const here = new URL(window.location.href);
    here.hash = '';
    if (this.authMode === 'platform-cookie') {
      const res = await fetch('/.pas/auth/email/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, returnTo: `${here.pathname}${here.search}` }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Magic-link request failed: ${res.status} ${body}`);
      }
      return;
    }
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
   * Self-service registration (#118): create a credential account for THIS
   * person with an email + password, then sign them in. The platform answers
   * the registration with 202 whether the address is new or already registered
   * (no enumeration) and mints no session for it; the sign-in that follows is
   * the ordinary credential login, so a duplicate registration by someone who
   * does not know the existing password ends in the same "Invalid login or
   * password" as any wrong password. The password is sent once and never
   * stored client-side — only the resulting session is.
   *
   * Policy: 12+ characters, not a common password. In platform-cookie mode
   * both calls go through the app origin (`/.pas/auth/credentials/*`), never
   * to the API from JS.
   *
   * @throws on a policy / validation error (400, with the platform's message),
   *   when registration is disabled (403), when rate-limited (429), or when the
   *   sign-in that follows fails (401).
   */
  async register(email: string, password: string, displayName?: string, opts: RegisterOptions = {}): Promise<User> {
    const body = JSON.stringify({
      email,
      password,
      ...(displayName ? { displayName } : {}),
      ...(opts.turnstileToken ? { turnstileToken: opts.turnstileToken } : {}),
    });
    const res = this.authMode === 'platform-cookie'
      ? await fetch('/.pas/auth/credentials/register', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body })
      : await fetch(new URL('/v1/auth/credentials/register', this.apiBase), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text body */ }
      if (res.status === 403 && /bot check/i.test(message)) throw new Error(opts.turnstileToken ? 'Bot check failed — please try again.' : 'Bot check required — complete the challenge and try again.');
      if (res.status === 403) throw new Error('Registration is not enabled for this platform.');
      if (res.status === 503 && /bot check/i.test(message)) throw new Error('Bot check unavailable — please try again in a moment.');
      if (res.status === 429) throw new Error('Too many registration attempts — please try again later.');
      throw new Error(message || `Registration failed (${res.status})`);
    }
    return this.signInWithCredentials(email, password);
  }

  /**
   * The Turnstile site key sign-up forms must render, or null when the platform
   * does not enforce the bot check (#26). Render the widget with
   * `data-sitekey` = siteKey and `data-action` = action, then pass the token it
   * yields as `register(..., { turnstileToken })`. Public, cacheable.
   */
  async turnstileSiteKey(): Promise<{ siteKey: string | null; action: string }> {
    const res = this.authMode === 'platform-cookie'
      ? await fetch('/.pas/auth/turnstile', { credentials: 'same-origin' })
      : await fetch(new URL('/v1/auth/turnstile', this.apiBase));
    if (!res.ok) return { siteKey: null, action: 'register' };
    const data = (await res.json()) as { siteKey?: unknown; action?: unknown };
    return {
      siteKey: typeof data.siteKey === 'string' && data.siteKey ? data.siteKey : null,
      action: typeof data.action === 'string' ? data.action : 'register',
    };
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
      const res = await fetch('/.pas/auth/credentials/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 401) throw new Error('Invalid login or password.');
        if (res.status === 429) throw new Error('Too many sign-in attempts — please try again later.');
        throw new Error(`Sign-in failed (${res.status}): ${body}`);
      }
      const user = normalizeUser((await res.json()) as User);
      this.session = { token: null, user };
      this.lastAuthError = null;
      this.emit();
      this.ensureMember();
      return user;
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
   * to be signed in as a creator (adult) or be authorized by this app's
   * `can_provision_student_credentials` action. Returns the generated `login`
   * and `password` ONCE — the password is never retrievable again, so surface
   * it to the adult immediately (copy/print) and let them reset it if lost.
   *
   * Pass `login` to choose the username (else an `animal-animal-animal` triple
   * is generated), `displayName` for a friendly display handle, and `isChild`
   * (defaults to true). The provisioned account does NOT replace the current
   * session — the adult stays signed in.
   *
   * @throws if not authorized (403) or the login is taken (409).
   */
  async provisionChild(
    opts: { login?: string; displayName?: string; isChild?: boolean; password?: string; orgId?: string; schoolId?: string | null } = {},
  ): Promise<{ uid: string; login: string; password: string; isChild: boolean }> {
    const res = await this.authenticatedFetch(new URL('/v1/auth/credentials/provision', this.apiBase), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...opts, appId: this.appId }),
    });
    if (res.status === 401) {
      this.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 403) throw new Error('You are not allowed to provision accounts.');
      if (res.status === 409) throw new Error('That login is already taken.');
      throw new Error(`Provision failed (${res.status}): ${body}`);
    }
    return (await res.json()) as { uid: string; login: string; password: string; isChild: boolean };
  }

  /**
   * Reset the password for a credential (child) account. Returns the new
   * random password ONCE — show it to the student immediately. Only callable
   * by a signed-in creator or app-authorized staff member. The old password is
   * invalidated.
   */
  async resetPassword(targetUserId: string): Promise<{ password: string }> {
    const res = await this.authenticatedFetch(new URL('/v1/auth/credentials/reset-password', this.apiBase), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetUserId, appId: this.appId }),
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

  /** Clear the session and notify listeners. A sign-out is a definite answer: the status becomes `signed-out` at once. */
  signOut(): void {
    this.transitionToSignedOut({
      reason: 'explicit_sign_out', phase: 'explicit_sign_out', route: 'auth.logout', correlationId: newCorrelationId(),
    });
    if (this.authMode === 'platform-cookie') {
      if (typeof fetch !== 'undefined') {
        fetch('/.pas/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      }
    }
  }

  /**
   * @internal Called by Kv and ApiProxy on 401 responses.
   * Clears the stale session so the UI reacts immediately.
   * Do not call directly — use `signOut()` instead.
   */
  handleUnauthorized(context?: InvalidationContext): void {
    // SDK primitives still call this after `authenticatedFetch`. That fetch has
    // already acted on a verified API-plane signal; a bare call must never turn
    // a data-plane 401 into a logout.
    if (context) {
      this.transitionToSignedOut(context);
    } else if (this.authMode === 'legacy-bearer') {
      // Backward-compatible for legacy SDK primitives. Cookie-mode calls must
      // be accompanied by the host's authoritative invalidation headers.
      this.transitionToSignedOut({
        reason: 'api_401', phase: 'api_request', route: 'platform.api', correlationId: newCorrelationId(), status: 401,
      });
    }
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
  init(): Promise<void> {
    // Every useAuth and ProShell calls init(). The session check runs once per
    // page (concurrent callers share it); later calls only act on a new auth
    // callback in the URL — so a component mounting mid-session never re-asks
    // /.pas/auth/me, and a transient failure there cannot sign the user out.
    if (this.initialized && !this.callbackInUrl()) return Promise.resolve();
    this.initializing ??= this.runInit().finally(() => {
      this.initializing = null;
      this.initialized = true;
      // The status leaves `pending` when the check settles, whatever the outcome.
      if (!this.resolved) {
        this.resolved = true;
        this.emit();
      }
    });
    return this.initializing;
  }

  private callbackInUrl(): boolean {
    if (typeof window === 'undefined') return false;
    const hash = window.location.hash;
    return hash.startsWith(SESSION_HASH) || hash.startsWith('#auth_error=');
  }

  private async runInit(): Promise<void> {
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
          this.transitionToSignedOut({
            reason: 'legacy_session_rejected', phase: 'legacy_hydration', route: 'auth.me', correlationId: newCorrelationId(),
          });
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
    const targetString = target.toString();
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
    if (response.status === 401) {
      if (this.authMode === 'platform-cookie') {
        // Only the host's API plane is the session authority. This preserves
        // the data-plane 401 rule even when an app primitive calls the legacy
        // bare `handleUnauthorized()` afterward. A new SDK with an old host
        // still signs out safely; it simply cannot join that event to a host id.
        if (targetString === '/.pas/api' || targetString.startsWith('/.pas/api/')) {
          const fromHost = response.headers.get(INVALIDATION_ID_HEADER) ?? '';
          const correlationId = (
            response.headers.get(INVALIDATION_REASON_HEADER) === 'api_401'
            && CORRELATION_ID_RE.test(fromHost)
          ) ? fromHost : newCorrelationId();
          this.handleUnauthorized({ reason: 'api_401', phase: 'api_request', route: 'platform.api', correlationId, status: 401 });
        }
      } else if (this.isPlatformApi(input)) {
        this.handleUnauthorized({
          reason: 'api_401', phase: 'api_request', route: 'platform.api', correlationId: newCorrelationId(), status: 401,
        });
      }
    }
    return response;
  }

  private async hydratePlatformCookieSession(): Promise<void> {
    try {
      const response = await fetch('/.pas/auth/me', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        if (response.status === 401) {
          const correlationId = response.headers.get(INVALIDATION_ID_HEADER) ?? newCorrelationId();
          this.handleUnauthorized({
            reason: 'api_401', phase: 'cookie_hydration', route: 'auth.me', correlationId,
            status: 401,
          });
        } else {
          this.reportHydrationFailure('cookie_hydration', 'auth.me', response.status);
        }
        return;
      }
      const user = normalizeUser((await response.json()) as User);
      this.session = { token: null, user };
      this.lastAuthError = null;
      this.emit();
      this.ensureMember();
    } catch {
      // A transport failure is not proof that a previously authenticated
      // session is invalid. Keep it, but leave a bounded diagnostic for the
      // unresolved hydration attempt.
      this.reportHydrationFailure('cookie_hydration', 'auth.me');
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

  private isPlatformApi(input: string | URL): boolean {
    try {
      return new URL(input.toString(), this.apiBase).origin === new URL(this.apiBase).origin;
    } catch {
      return false;
    }
  }

  private transitionToSignedOut(context: InvalidationContext | {
    reason: 'explicit_sign_out'; phase: 'explicit_sign_out'; route: 'auth.logout'; correlationId: string; status?: never;
  }): void {
    const priorAuthenticated = this.session !== null;
    this.session = null;
    this.resolved = true;
    if (this.authMode === 'legacy-bearer') this.clearStorage();
    if (priorAuthenticated) {
      this.reporter?.captureAuthEvent({
        category: 'auth.session_lost',
        reason: context.reason,
        phase: context.phase,
        route: context.route,
        correlationId: context.correlationId,
        priorAuthenticated: true,
        ...(context.status === undefined ? {} : { status: context.status }),
        ...this.telemetryContext(),
      });
    }
    this.emit();
  }

  private reportHydrationFailure(phase: 'cookie_hydration' | 'legacy_hydration', route: 'auth.me', status?: number): void {
    this.reporter?.captureAuthEvent({
      category: 'auth.hydration_failure', reason: status === undefined ? 'network_error' : 'http_error', phase, route,
      correlationId: newCorrelationId(), priorAuthenticated: this.session !== null,
      ...(status === undefined ? {} : { status }),
      ...this.telemetryContext(),
    });
  }

  private telemetryContext(): Pick<AuthTelemetryEvent, 'elapsedMs' | 'online' | 'visibility'> {
    const navigatorLike = globalThis as { navigator?: { onLine?: boolean } };
    const documentLike = globalThis as { document?: { visibilityState?: string } };
    const visibility = documentLike.document?.visibilityState;
    return {
      elapsedMs: Math.min(10 * 60 * 1000, Math.max(0, Math.trunc(Date.now() - this.sessionStartedAt))),
      online: typeof navigatorLike.navigator?.onLine === 'boolean' ? navigatorLike.navigator.onLine : null,
      visibility: visibility === 'visible' || visibility === 'hidden' ? visibility : 'unknown',
    };
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
    for (const listener of this.statusListeners) listener(this.status, this.user);
  }
}

function newCorrelationId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '').toLowerCase();
    }
  } catch { /* fall through */ }
  // Correlation-only, never security material; fixed 32-hex shape for the log sink.
  return `${Math.random().toString(16).slice(2).padEnd(16, '0')}${Math.random().toString(16).slice(2).padEnd(16, '0')}`.slice(0, 32);
}

function normalizeUser(data: User): User {
  if (!data.login) data.login = data.name || data.id;
  if (!data.name) data.name = data.login || data.id;
  return data;
}
