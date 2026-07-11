/**
 * Usage telemetry — heartbeats `POST /v1/usage/ping` while the tab is visible.
 *
 * Auto-started by `initPro()` unless `usage.auto === false` in the options.
 * The collected (app, user, day) counts drive the usage-proportional creator
 * payouts described in proappstore.online/pricing.
 *
 * Design notes:
 *
 * - **Visible-time only.** We start a stopwatch when the tab is visible and
 *   pause on `visibilitychange`. A tab that's been hidden for 90s contributes
 *   0 seconds for that interval.
 * - **Browser-only.** All methods no-op when `document` or `window` is
 *   undefined so the import is SSR-safe.
 * - **Silent failures.** Telemetry must never break an app. Every network
 *   path catches + ignores errors.
 * - **Page-close flush.** On `pagehide` we send a final ping with the
 *   residual elapsed seconds via `navigator.sendBeacon` (survives unload)
 *   falling back to `fetch(..., { keepalive: true })`.
 */

interface AuthLike {
  token: string | null;
  isSignedIn?: boolean;
  usesPlatformCookie?: boolean;
}

export interface UsageOptions {
  /** Default true. Set false to disable auto-heartbeat in this app. */
  auto?: boolean;
}

const HEARTBEAT_MS = 60_000;
const MAX_DELTA_SECONDS = 90;

function hasBrowser(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

export class Usage {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private visibleSince: number | null = null;
  /** Accumulated visible-time since the last successful ping, in milliseconds. */
  private accruedMs = 0;
  private pendingApiCalls = 0;
  private onVisibility: (() => void) | null = null;
  private onPageHide: (() => void) | null = null;

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** Begin heartbeat reporting. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.running) return;
    if (!hasBrowser()) return;
    this.running = true;

    // Initial visibility snapshot.
    if (document.visibilityState === 'visible') {
      this.visibleSince = performance.now();
    }

    this.onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (this.visibleSince == null) this.visibleSince = performance.now();
      } else {
        this.bankVisible();
      }
    };
    document.addEventListener('visibilitychange', this.onVisibility);

    this.onPageHide = () => {
      this.flush();
    };
    window.addEventListener('pagehide', this.onPageHide);

    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, HEARTBEAT_MS);
  }

  /** Stop heartbeats. Idempotent. Doesn't flush; call `flush()` if you need to. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (hasBrowser()) {
      if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
      if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide);
    }
    this.onVisibility = null;
    this.onPageHide = null;
    this.visibleSince = null;
    this.accruedMs = 0;
    this.pendingApiCalls = 0;
  }

  /**
   * Record API calls. Bumps a local counter that piggybacks on the next
   * heartbeat. Cheap to call from hot paths — no network until the next tick.
   */
  recordApiCall(n: number = 1): void {
    if (!Number.isFinite(n) || n <= 0) return;
    this.pendingApiCalls += Math.floor(n);
  }

  /**
   * Send a final ping (intended for page-close paths). Best-effort,
   * fire-and-forget. Uses sendBeacon when available so the request survives
   * unload; falls back to keepalive fetch otherwise.
   */
  flush(): void {
    if (!hasBrowser()) return;
    this.bankVisible();
    const seconds = this.drainSeconds();
    const apiCalls = this.drainApiCalls();
    if (seconds === 0 && apiCalls === 0) return;
    this.send(seconds, apiCalls, /* keepalive */ true);
  }

  // ── internal ──────────────────────────────────────────────────────────────

  /** Add any in-progress visible-time to the running accrual. */
  private bankVisible(): void {
    if (this.visibleSince == null) return;
    const now = performance.now();
    this.accruedMs += Math.max(0, now - this.visibleSince);
    this.visibleSince = null;
  }

  /** Round accrued ms to whole seconds, clamp to MAX_DELTA_SECONDS, return + reset. */
  private drainSeconds(): number {
    const whole = Math.floor(this.accruedMs / 1000);
    if (whole <= 0) return 0;
    const sent = Math.min(MAX_DELTA_SECONDS, whole);
    this.accruedMs -= sent * 1000;
    // Cap residual so a long-hidden flush after a long visible run doesn't
    // ride along on the next ping forever.
    if (this.accruedMs < 0) this.accruedMs = 0;
    return sent;
  }

  private drainApiCalls(): number {
    const n = this.pendingApiCalls;
    this.pendingApiCalls = 0;
    return n;
  }

  private async tick(): Promise<void> {
    this.bankVisible();
    if (document.visibilityState === 'visible') {
      this.visibleSince = performance.now();
    }
    const seconds = this.drainSeconds();
    const apiCalls = this.drainApiCalls();
    if (seconds === 0 && apiCalls === 0) return;
    if (!this.isAuthenticated()) {
      // Re-pocket the work — the user may sign in later and we'd like the
      // accrued time to count from then. Note: a session-token signin BEFORE
      // any visible time was banked won't have anything to attribute, and
      // that's fine — anonymous usage isn't part of the payout math anyway.
      this.accruedMs += seconds * 1000;
      this.pendingApiCalls += apiCalls;
      return;
    }
    await this.send(seconds, apiCalls, /* keepalive */ false);
  }

  private async send(seconds: number, apiCalls: number, keepalive: boolean): Promise<void> {
    if (!this.isAuthenticated()) return;
    const body = JSON.stringify({
      appId: this.appId,
      deltaSeconds: seconds,
      deltaApiCalls: apiCalls,
    });
    const url = this.auth.usesPlatformCookie ? '/.pas/api/v1/usage/ping' : `${this.apiBase}/v1/usage/ping`;

    // Prefer sendBeacon for keepalive (unload survivor) paths. sendBeacon
    // doesn't allow setting custom Authorization headers. In platform-cookie
    // mode the same-origin beacon carries the HttpOnly app cookie; in legacy
    // mode this remains best-effort and falls back to bearer fetch when needed.
    if (keepalive && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        const blob = new Blob([body], { type: 'application/json' });
        const ok = navigator.sendBeacon(url, blob);
        if (ok) return;
      } catch {
        // fall through
      }
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const init: RequestInit = {
        method: 'POST',
        headers,
        body,
        keepalive,
      };
      if (this.auth.usesPlatformCookie) {
        init.credentials = 'same-origin';
      } else {
        const token = this.auth.token;
        if (!token) return;
        headers.Authorization = `Bearer ${token}`;
      }
      await fetch(url, {
        ...init,
      });
    } catch {
      // Telemetry never breaks an app.
    }
  }

  private isAuthenticated(): boolean {
    return this.auth.usesPlatformCookie ? this.auth.isSignedIn === true : !!this.auth.token;
  }
}
