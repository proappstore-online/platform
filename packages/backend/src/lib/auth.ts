import type { Context } from 'hono';
import { verifySession } from '@proappstore/build-core';
import type { Env } from '../types.js';

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Extra fields for the JSON error body, beside `error` (e.g. step_up_required's `message`). */
    public readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface FasUser {
  id: string;
  login: string;
  avatarUrl: string | null;
  /** Platform-level roles from session token: 'user', 'creator', 'admin'. */
  roles: string[];
  /** Session `auth_time` (#230): when the user last actively authenticated, epoch seconds. */
  authTime?: number;
  /** Session `auth_method` (#230): how they did — 'github', 'google', 'password', 'passkey'. */
  authMethod?: string;
  /** Verified WebAuthn relying party of a passkey step-up (#331). */
  stepUpRpId?: string;
  /** Per-app roles: { appId: ['moderator', ...] }. */
}

/**
 * Verify the Bearer token locally via SESSION_SIGNING_KEY (no FAS round-trip).
 * PAS mints its own tokens — see build-core/session-jwt.
 */
export async function requireUser(c: Context<{ Bindings: Env }>): Promise<FasUser> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError('missing bearer token', 401);
  }
  const claims = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY);
  if (!claims) {
    throw new HttpError('invalid or expired session', 401);
  }
  return {
    id: claims.uid,
    login: claims.login ?? claims.uid,
    avatarUrl: claims.avatarUrl ?? null,
    roles: claims.roles ?? ['user'],
    ...(typeof claims.auth_time === 'number' ? { authTime: claims.auth_time } : {}),
    ...(typeof claims.auth_method === 'string' ? { authMethod: claims.auth_method } : {}),
    ...(typeof claims.step_up_rp_id === 'string' ? { stepUpRpId: claims.step_up_rp_id } : {}),
  };
}

export const DEFAULT_STEP_UP_MAX_AGE_SECONDS = 300;

/** The step-up window: STEP_UP_MAX_AGE_SECONDS when a positive integer, else 300. */
export function stepUpMaxAgeSeconds(env: Pick<Env, 'STEP_UP_MAX_AGE_SECONDS'>): number {
  const configured = Number(env.STEP_UP_MAX_AGE_SECONDS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_STEP_UP_MAX_AGE_SECONDS;
}

/**
 * Require that the caller authenticated recently (#231) — for step_up actions.
 * A session without `auth_time` (minted before #230) is never recent.
 *
 * 403, not 401: the caller IS authenticated, and the host treats a 401 from the
 * API as a dead session and clears the cookie — which would sign the user out
 * instead of letting the client run the passkey step-up
 * (`/.pas/auth/passkey/step-up`) and retry.
 */
export function requireRecentAuth(
  user: FasUser,
  env: Pick<Env, 'STEP_UP_MAX_AGE_SECONDS'>,
  opts: { method?: 'passkey'; rpId?: string } = {},
): void {
  const maxAge = stepUpMaxAgeSeconds(env);
  const age = user.authTime === undefined ? Infinity : Math.floor(Date.now() / 1000) - user.authTime;
  // `method: 'passkey'` (#244): only a passkey step-up counts — a fresh OAuth or
  // password sign-in does not. The body says so, so the client runs the passkey
  // ceremony rather than a sign-in that would be refused again.
  // A relying-party audience (#331) is met only by `step_up_rp_id`, which only a
  // passkey step-up on that relying party mints: requiring one requires a
  // passkey, and the refusal says so (#337), or the client would send the user
  // to sign in again and be refused again.
  const method = opts.rpId !== undefined ? 'passkey' : opts.method;
  const wrongMethod = method !== undefined && user.authMethod !== method;
  // An omitted claim is a refusal when an audience is required: tokens minted
  // before #331 cannot become a wildcard step-up for every relying party.
  const wrongRp = opts.rpId !== undefined && user.stepUpRpId !== opts.rpId;
  if (!(age <= maxAge) || wrongMethod || wrongRp) {
    throw new HttpError('step_up_required', 403, {
      message: method ? 'Recent passkey verification required' : 'Recent authentication required',
      max_age: maxAge,
      ...(method ? { method } : {}),
    });
  }
}

/**
 * Resolve the caller if they have a valid session, else null. Never throws for
 * missing or bad credentials.
 *
 * For endpoints where being signed out is a legitimate state rather than an
 * error — app log ingestion above all (ADR-008 §2): a white screen on load or a
 * failed credential sign-in has no session *by definition*, and those are
 * exactly the failures worth capturing. `requireUser` would 401 away the most
 * valuable reports.
 *
 * Callers must not treat a null user as "trusted anonymous": pair this with a
 * quota and, where available, the trusted app-context binding.
 */
export async function optionalUser(c: Context<{ Bindings: Env }>): Promise<FasUser | null> {
  try {
    return await requireUser(c);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Role systems — PAS has THREE distinct role scopes. They are intentionally
// separate (like GitHub: account type vs repo-collaborator role vs your app's
// own users). Some words collide across scopes (`admin`, `owner`, `viewer` each
// appear in two) — so always use the scope-specific type + check, never mix
// them. Full guide: docs/authorization-model.md.
//
//   1. PlatformRole — the identity's relationship to ProAppStore itself
//      (publish, platform admin). From the session JWT. Platform-admin routes
//      check requireAdmin(); other platform capabilities define their own
//      explicit policy instead of a generic role gate.
//   2. TeamRole     — who may BUILD/operate an app (repo, data, deploy). From
//      team_members. Check: requireAppAccess()/requireAppOwner().
//   3. AppRole      — roles within an app's OWN user base (the app author's
//      RBAC; custom strings allowed). From app_roles. Check: enforceActionAuth
//      (backend/routes/actions.ts) + the tool SQL guards.
// ---------------------------------------------------------------------------

/** Platform-level roles from the session token, ordered by privilege. */
export const PLATFORM_ROLES = ['user', 'creator', 'admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Team roles ordered by privilege level (higher index = more access). */
export const TEAM_ROLES = ['viewer', 'po', 'developer', 'admin', 'owner'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Conventional app roles (the app author may also assign any custom string), so
 * the type is a widened string. Listed for documentation + tooling.
 */
export const APP_ROLE_CONVENTIONS = ['owner', 'member', 'moderator', 'editor', 'viewer'] as const;
export type AppRole = string;

/**
 * Verify the signed-in user has access to the given app. Checks (in order):
 * 1. team_members table (multi-user access)
 * 2. apps.creator_id (legacy single-owner, auto-migrated)
 * 3. Platform admin role in session token
 *
 * Returns the user + their team role. Throws 403/404 otherwise.
 * `minRole` defaults to 'viewer' (any team member). Pass 'owner' for
 * destructive operations, 'developer' for code writes, etc.
 */
export async function requireAppAccess(
  c: Context<{ Bindings: Env }>,
  appId: string,
  minRole: TeamRole = 'viewer',
): Promise<FasUser & { teamRole: TeamRole }> {
  const user = await requireUser(c);

  // Platform admin bypasses everything
  if (user.roles.includes('admin')) {
    return { ...user, teamRole: 'owner' };
  }

  // Fast path: check creator_id first (backwards compatible, most common case)
  const app = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ creator_id: string }>();
  if (!app) throw new HttpError('app not found', 404);

  let teamRole: TeamRole;

  if (app.creator_id === user.id) {
    teamRole = 'owner'; // creator is always owner
  } else {
    // Check team_members table for multi-user access
    const member = await c.env.DB.prepare(
      'SELECT role FROM team_members WHERE app_id = ? AND user_id = ?',
    )
      .bind(appId, user.id)
      .first<{ role: string }>();

    if (!member) throw new HttpError('not the app owner', 403);
    teamRole = (TEAM_ROLES.includes(member.role as TeamRole) ? member.role : 'viewer') as TeamRole;
  }

  // Check minimum role level
  const userLevel = TEAM_ROLES.indexOf(teamRole);
  const minLevel = TEAM_ROLES.indexOf(minRole);
  if (userLevel < minLevel) {
    throw new HttpError(`requires ${minRole} role (you have ${teamRole})`, 403);
  }

  return { ...user, teamRole };
}

/**
 * Backwards-compatible alias. Checks for owner-level access.
 * Use requireAppAccess(c, appId, 'developer') for write operations,
 * or requireAppAccess(c, appId, 'viewer') for read-only.
 */
export async function requireAppOwner(
  c: Context<{ Bindings: Env }>,
  appId: string,
): Promise<FasUser> {
  return requireAppAccess(c, appId, 'owner');
}

/**
 * Whether a stored user id (`gh:<id>`) is a platform admin — in `ADMIN_GITHUB_IDS`.
 * For ids with no session behind them, such as `apps.creator_id`; a session's
 * own admin role is `requireAdmin`.
 */
export function isAdminId(userId: string, env: Pick<Env, 'ADMIN_GITHUB_IDS'>): boolean {
  if (!env.ADMIN_GITHUB_IDS) return false;
  return env.ADMIN_GITHUB_IDS.split(',')
    .map((s) => s.trim())
    .includes(userId);
}

/**
 * Require a platform admin. Checks 'admin' role in session token claims.
 */
export async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<FasUser> {
  const user = await requireUser(c);
  if (!user.roles.includes('admin')) throw new HttpError('admin only', 403);
  return user;
}
