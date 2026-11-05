interface AuthLike {
  token: string | null;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/** The slice of Web Storage the capture needs (injectable, so it works without a DOM). */
export interface ReferralStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * What the platform answered for a claim. Never who the promoter is.
 * `pending`: captured, credited when the person's first activation is recorded; `confirmed`: credited;
 * `not_eligible` / `invalid_code` / `already_attributed`: nothing to credit (and nothing more to retry);
 * `unverified_origin`: this request was not made from inside the app, so nothing was stored.
 */
export type ReferralState = 'pending' | 'confirmed' | 'not_eligible' | 'invalid_code' | 'already_attributed' | 'unverified_origin';
export interface ReferralClaimResult { credited: boolean; state: ReferralState }

/** A reporting period: `from <= time < to`. ISO date (`2026-10-01`, UTC), an ISO date-time with a zone, or epoch milliseconds. */
export interface ContributionPeriodQuery { from?: string | number; to?: string | number }

/** What the platform says a promoter's share is: this promoter's confirmed referrals over all promoters' for the app and period. Not a share of all users. */
export interface ContributionShare { numerator: number; denominator: number; ratio: number; percent: number; basis: string }

/** One public contributor card: only a name and label the person chose, a confirmed count and a share among promoters. */
export interface PublicContributorCard {
  display_name: string;
  label: string | null;
  contributions: {
    promotion: { type: 'promotion_marketing'; label: string; recorded: true; confirmed_referrals: number; share_of_referred_users: ContributionShare };
    /** Code (lines-of-code) contribution is reported separately and is not available yet; never combined with promotion. */
    code: { type: 'code'; available: false };
  };
}
export interface PublicContributors { version: number; app_id: string; period: { from: number | null; to: number | null; from_iso: string | null; to_iso: string | null }; contributors: PublicContributorCard[] }
export type PublicContributorCardResponse = PublicContributorCard & Pick<PublicContributors, 'version' | 'app_id' | 'period'>;

/** What a promoter reads about themselves with a first-party session (`GET /v1/apps/:appId/promoters/me/contributions`). Typed here for platform clients. */
export interface PromoterContributions {
  version: number;
  app_id: string;
  freshness: { as_of: number; referrals_recorded_since: number | null; note: string };
  contributions: {
    promotion: {
      type: 'promotion_marketing'; label: string; promoter_status: 'active' | 'suspended' | 'withdrawn'; recorded: boolean; first_confirmed_at: number | null;
      counts: { pending: number; confirmed: number; reversed: number; expired: number };
      share_of_referred_users: ContributionShare;
      standing: { rank: number | null; ranked_promoters: number; tied_on_count: boolean };
    };
    code: { type: 'code'; label: string; available: false; reason: string };
  };
}

/** What an app owner reads with a first-party session (`GET /v1/apps/:appId/promoters/contributions`). Typed here for platform clients. */
export interface PromoterStandings {
  version: number;
  app_id: string;
  freshness: PromoterContributions['freshness'];
  totals: { confirmed: number; pending: number; reversed: number; expired: number; promoters: number; ranked_promoters: number };
  /** Organic users are kept apart from every promoter's number. */
  acquisition: { activations_recorded: number; referred_confirmed: number; referred_reversed: number; organic: number; note: string };
  standings: {
    rank: number | null; tied_on_count: boolean; promoter_id: string; display_name: string | null; status: string;
    counts: { pending: number; confirmed: number; reversed: number; expired: number }; first_confirmed_at: number | null; share_of_referred_users: ContributionShare;
  }[];
  next: { after_id: string } | null;
}

const STORAGE_KEY = 'pas_referral';
/** How long a captured code is kept on this device before it is dropped. The platform's own pending window is the same. */
export const REFERRAL_CAPTURE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// The platform's code alphabet: 2-9 and A-Z without I and O.
const CODE = /^[2-9A-HJ-NP-Z]{8}$/;

function normalize(value: string | null): string | null {
  const code = value?.toUpperCase().replace(/[\s-]/g, '') ?? '';
  return CODE.test(code) ? code : null;
}

function defaultStorage(): ReferralStorage | null {
  try { return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null; } catch { return null; }
}

/**
 * Referral capture across sign-in (#550). A personal link carries `?ref=<code>`. `capture()` keeps the code on this
 * device (first valid code wins, and it expires) so it survives the trip to PAS sign-in and back; `claim()` then
 * sends only that public code to the platform from inside the signed-in app. The platform resolves the code to a
 * verified promoter itself, decides whether this person qualifies, and credits them only when its own record of
 * their first activation of the app exists. The SDK cannot confirm or count anything. It never fingerprints the
 * device and never links two PAS identities: a referral made on another device or under another sign-in is not
 * recognised, by design.
 *
 * The SDK starts this itself: it captures on load and claims once the person is signed in. Nothing is sent when
 * no code was captured.
 */
export class Referrals {
  private inFlight: Promise<ReferralClaimResult | null> | null = null;

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
    private readonly storage: ReferralStorage | null = defaultStorage(),
    private readonly now: () => number = Date.now,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private periodQuery(period?: ContributionPeriodQuery): string {
    const query = new URLSearchParams();
    if (period?.from !== undefined) query.set('from', String(period.from));
    if (period?.to !== undefined) query.set('to', String(period.to));
    const text = query.toString();
    return text ? `?${text}` : '';
  }

  /**
   * The public contributor cards of this app: people who chose to show their promotion contribution. Public, no sign-in.
   * `null` when the app is private or unknown. Own totals and owner standings need a first-party session and are read by the
   * Console, not from inside an app; see {@link PromoterContributions} and {@link PromoterStandings}.
   */
  async contributors(period?: ContributionPeriodQuery): Promise<PublicContributors | null> {
    const response = await this.fetcher(`${this.apiBase}/v1/storefront/apps/${encodeURIComponent(this.appId)}/contributors${this.periodQuery(period)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Could not load contributors (${response.status}).`);
    return (await response.json()) as PublicContributors;
  }

  /** One public contributor card, addressed by the opaque promoter id. `null` unless that person opted in and has a recorded contribution. */
  async publicCard(promoterId: string, period?: ContributionPeriodQuery): Promise<PublicContributorCardResponse | null> {
    const response = await this.fetcher(`${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/promoters/${encodeURIComponent(promoterId)}/public-card${this.periodQuery(period)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Could not load the contributor card (${response.status}).`);
    return (await response.json()) as PublicContributorCardResponse;
  }

  /** Keep the `ref` code from `href` (default: this page). Returns the code now held, or null. The URL is not changed. */
  capture(href?: string): string | null {
    const held = this.pending();
    if (held) return held.code; // the first valid code stands
    let code: string | null = null;
    try { code = normalize(new URL(href ?? (typeof window !== 'undefined' ? window.location.href : '')).searchParams.get('ref')); } catch { code = null; }
    if (!code || !this.storage) return code;
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify({ code, appId: this.appId, capturedAt: this.now() })); } catch { /* storage may be blocked */ }
    return code;
  }

  /** The code held for this app, unless it has expired. */
  pending(): { code: string; capturedAt: number } | null {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      const held = JSON.parse(raw) as { code?: unknown; appId?: unknown; capturedAt?: unknown };
      if (held.appId !== this.appId || typeof held.capturedAt !== 'number' || normalize(String(held.code)) !== held.code) { this.clear(); return null; }
      if (this.now() - held.capturedAt > REFERRAL_CAPTURE_TTL_MS || held.capturedAt > this.now() + 60_000) { this.clear(); return null; }
      return { code: held.code as string, capturedAt: held.capturedAt };
    } catch { this.clear(); return null; }
  }

  clear(): void {
    try { this.storage?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  /**
   * Send the held code to the platform, if there is one and the person is signed in. A definite answer (credited,
   * pending, or a reason there is nothing to credit) clears the code; a network or server failure keeps it for the
   * next attempt. Returns null when there was nothing to send or the attempt failed. Concurrent calls share one request.
   */
  claim(): Promise<ReferralClaimResult | null> {
    this.inFlight ??= this.send().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async send(): Promise<ReferralClaimResult | null> {
    const held = this.pending();
    if (!held || !this.auth.token) return null;
    try {
      const response = await this.auth.authenticatedFetch(`${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/referrals/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: held.code }),
      });
      if (!response.ok) return null;
      const result = (await response.json()) as ReferralClaimResult;
      if (typeof result?.state !== 'string') return null;
      this.clear();
      return result;
    } catch {
      return null;
    }
  }
}
