interface AuthLike {
  token: string | null;
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface Invite {
  id: string;
  code: string;
  link: string;
  qr: string;
  role: string;
  group: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: number;
}

export interface InviteListItem extends Omit<Invite, 'qr'> {
  metadata: Record<string, unknown> | null;
  expired: boolean;
  exhausted: boolean;
  createdBy: string;
  createdAt: number;
}

export interface CreateInviteOptions {
  /** Role to assign on redeem. Default: 'member'. */
  role?: string;
  /** Optional group/org/team scope. */
  group?: string;
  /** Optional app-specific data passed through on redeem. */
  metadata?: Record<string, unknown>;
  /** Max redemptions. Default: 1. */
  uses?: number;
  /** TTL string (e.g. '30m', '24h', '7d'). Default: '7d'. */
  expiresIn?: string;
}

export interface RedeemResult {
  ok: boolean;
  role: string;
  group: string | null;
  metadata: Record<string, unknown> | null;
  appId: string;
}

/**
 * Invite links — platform-level join codes with link + QR.
 *
 * Three entry points, one code:
 * - **Code** — say out loud, write on whiteboard
 * - **Link** — send via email, WhatsApp, Slack, SMS
 * - **QR code** — display on projector, print on handout
 *
 * @example
 *   const invite = await app.invites.create({
 *     role: 'student',
 *     uses: 30,
 *     expiresIn: '7d',
 *   })
 *   invite.code  // "HKWX3P"
 *   invite.link  // "https://my-app.proappstore.online/join/HKWX3P"
 *   invite.qr    // SVG string
 *
 *   const result = await app.invites.redeem('HKWX3P')
 *   // → { ok: true, role: 'student', group: null, metadata: null }
 */
export class Invites {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** Create an invite link. Caller must have developer-level app access. */
  async create(opts: CreateInviteOptions = {}): Promise<Invite> {
    const res = await this.post(`/v1/apps/${encodeURIComponent(this.appId)}/invites`, opts);
    return res as Invite;
  }

  /** List all invites for this app. Caller must have developer-level app access. */
  async list(): Promise<InviteListItem[]> {
    const res = await this.auth.authenticatedFetch(`${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/invites`);
    if (res.status === 401) { this.auth.handleUnauthorized(); throw new Error('Not signed in.'); }
    if (!res.ok) throw new Error(`invites.list failed: ${res.status}`);
    const data = (await res.json()) as { invites: InviteListItem[] };
    return data.invites;
  }

  /** Revoke an invite. Caller must have developer-level app access. */
  async revoke(inviteId: string): Promise<void> {
    const res = await this.auth.authenticatedFetch(
      `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/invites/${encodeURIComponent(inviteId)}`,
      { method: 'DELETE' },
    );
    if (res.status === 401) { this.auth.handleUnauthorized(); throw new Error('Not signed in.'); }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`invites.revoke failed: ${res.status} ${text}`);
    }
  }

  /**
   * Redeem an invite code. Any authenticated user.
   * Assigns the specified role and returns the invite details.
   */
  async redeem(code: string): Promise<RedeemResult> {
    const res = await this.post(`/v1/invites/${encodeURIComponent(code)}/redeem`, {});
    return res as RedeemResult;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.auth.authenticatedFetch(this.apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { this.auth.handleUnauthorized(); throw new Error('Not signed in.'); }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }
}
