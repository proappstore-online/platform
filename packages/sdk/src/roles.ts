interface AuthLike {
  token: string | null;
  handleUnauthorized(): void;
}

export interface RoleAssignment {
  userId: string;
  roleName: string;
  grantedBy: string | null;
  grantedAt: number;
}

/** Default roles provided by the platform. Devs can add custom roles. */
export const DEFAULT_ROLES = ['owner', 'member', 'moderator', 'editor', 'viewer'] as const;
export type DefaultRole = (typeof DEFAULT_ROLES)[number];

/**
 * App-level RBAC — assign, revoke, and check roles for users in your app.
 *
 * Default roles (no configuration needed):
 *   owner      — auto-assigned to app creator, full control
 *   member     — basic authenticated access
 *   moderator  — content moderation, user management
 *   editor     — CRUD on app data, not settings
 *   viewer     — read-only access
 *
 * Custom roles: pass any string to assign/revoke/check.
 *
 * @example
 *   await app.roles.assign('gh:123', 'moderator')
 *   const has = await app.roles.check('moderator')
 *   const mods = await app.roles.list('moderator')
 *   await app.roles.revoke('gh:123', 'moderator')
 */
export class Roles {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** Assign a role to a user. Caller must be app owner or admin. */
  async assign(userId: string, role: string): Promise<void> {
    await this.post(`/v1/apps/${encodeURIComponent(this.appId)}/roles`, { userId, role });
  }

  /** Revoke a role from a user. Caller must be app owner or admin. */
  async revoke(userId: string, role: string): Promise<void> {
    await this.del(`/v1/apps/${encodeURIComponent(this.appId)}/roles`, { userId, role });
  }

  /** Check if the current user has a specific role in this app. */
  async check(role: string): Promise<boolean> {
    const token = this.auth.token;
    if (!token) return false;
    const res = await fetch(
      `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/roles/check/${encodeURIComponent(role)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { has: boolean };
    return data.has;
  }

  /** List all role assignments for this app. Caller must be app owner or admin. */
  async listAll(): Promise<RoleAssignment[]> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const res = await fetch(`${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/roles`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) throw new Error(`roles.listAll failed: ${res.status}`);
    const data = (await res.json()) as { roles: RoleAssignment[] };
    return data.roles;
  }

  /** List all users with a specific role. Caller must be app owner or admin. */
  async list(role: string): Promise<RoleAssignment[]> {
    const all = await this.listAll();
    return all.filter((r) => r.roleName === role);
  }

  /** Get the current user's roles in this app. */
  async myRoles(): Promise<string[]> {
    const token = this.auth.token;
    if (!token) return [];
    const res = await fetch(`${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/roles/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { roles: string[] };
    return data.roles;
  }

  private async post(path: string, body: unknown): Promise<void> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const res = await fetch(this.apiBase + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${path} failed: ${res.status} ${text}`);
    }
  }

  private async del(path: string, body: unknown): Promise<void> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const res = await fetch(this.apiBase + path, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${path} failed: ${res.status} ${text}`);
    }
  }
}
