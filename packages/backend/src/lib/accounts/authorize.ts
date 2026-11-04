/**
 * The one authority for account and app permission decisions (#534 T03, ADR-013).
 *
 * `decide` is pure: facts in, decision out, so the whole matrix is table-testable. `loadFacts` reads
 * the facts in ONE statement (one snapshot of account, membership, grant and versions). Every path
 * fails closed: a missing row, an unknown role, an unexpected status or a failed read denies. There
 * is no fallback to apps.creator_id here, by design.
 *
 * Identity is not workspace: the caller supplies the resource; naming an account or app grants
 * nothing. A user id in a request body is never an identity (the principal comes from the session).
 */
import {
  ACCOUNT_ROLE_PERMISSIONS, APP_ROLE_PERMISSIONS, EXPLICIT_GRANTABLE, credentialMayExercise, isAccountRole, isAppRole,
  type AccountId, type AccountKind, type AppId, type CredentialKind, type Permission, type UserId,
} from './contract.js';

export interface Principal {
  userId: UserId;
  credential: CredentialKind;
  /** The one app an `app_bound` credential was issued to. */
  boundAppId?: AppId | undefined;
  /** Session carries the platform `admin` role. Compatibility support access only (see decide). */
  platformAdmin?: boolean | undefined;
}

export type Resource = { kind: 'account'; accountId: AccountId } | { kind: 'app'; appId: AppId };

type DenyReason =
  | 'not_found' | 'no_owner_account' | 'credential_scope' | 'account_not_active' | 'account_suspended'
  | 'not_a_member' | 'membership_removed' | 'unknown_role' | 'permission_missing' | 'stale_state';

export type Decision =
  | { allowed: true; via: 'account_role' | 'app_grant' | 'platform_admin_compat'; accountId: AccountId; role: string; versions: Versions }
  | { allowed: false; reason: DenyReason; accountId?: AccountId; versions?: Versions };

interface Versions { authz: number; ownership: number | null; access: number | null }

/** A mutation passes the versions it read; a mismatch is `stale_state`, never a silent proceed. */
export interface Expectations { authzVersion?: number; ownershipVersion?: number; accessVersion?: number }

export interface Facts {
  found: boolean;
  resource: Resource;
  accountId: AccountId | null;
  accountKind: AccountKind | null;
  accountStatus: string | null;
  versions: Versions;
  membership: { role: string; status: string; generation: number } | null;
  grant: { role: string; extra: string[]; generation: number; expiresAt: number | null } | null;
}

export function decide(principal: Principal, perm: Permission, facts: Facts, expect: Expectations = {}, now = Date.now()): Decision {
  if (!facts.found) return { allowed: false, reason: 'not_found' };
  const resourceApp = facts.resource.kind === 'app' ? facts.resource.appId : null;
  if (!credentialMayExercise(principal.credential, perm, resourceApp, principal.boundAppId ?? null)) {
    return { allowed: false, reason: 'credential_scope' };
  }
  if (facts.accountId === null) return { allowed: false, reason: 'no_owner_account' };
  const base = { accountId: facts.accountId, versions: facts.versions };
  if (facts.accountStatus !== 'active') {
    return { allowed: false, reason: facts.accountStatus === 'suspended' ? 'account_suspended' : 'account_not_active', ...base };
  }
  const stale =
    (expect.authzVersion !== undefined && expect.authzVersion !== facts.versions.authz) ||
    (expect.ownershipVersion !== undefined && expect.ownershipVersion !== facts.versions.ownership) ||
    (expect.accessVersion !== undefined && expect.accessVersion !== facts.versions.access);

  // Compatibility support access, mirroring today's platform-admin bypass on an existing app: app
  // permissions only, never account governance and never transfer. A narrowing of today's behavior
  // is a separate, tested change (design §3); the caller audits any use.
  if (principal.platformAdmin && perm.startsWith('app.') && perm !== 'app.transfer') {
    return stale ? { allowed: false, reason: 'stale_state', ...base } : { allowed: true, via: 'platform_admin_compat', accountId: facts.accountId, role: 'platform_admin', versions: facts.versions };
  }

  const m = facts.membership;
  if (!m) return { allowed: false, reason: 'not_a_member', ...base };
  if (m.status !== 'active') return { allowed: false, reason: 'membership_removed', ...base };
  if (!isAccountRole(m.role)) return { allowed: false, reason: 'unknown_role', ...base };

  let via: 'account_role' | 'app_grant' | null = ACCOUNT_ROLE_PERMISSIONS[m.role].includes(perm) ? 'account_role' : null;
  if (!via && facts.resource.kind === 'app' && perm.startsWith('app.') && facts.grant) {
    const g = facts.grant;
    // A grant counts only for the membership stint it was made in, and only until it expires.
    const live = g.generation === m.generation && (g.expiresAt === null || g.expiresAt > now);
    if (live && isAppRole(g.role)) {
      const extra = g.extra.filter((x): x is Permission => (EXPLICIT_GRANTABLE as readonly string[]).includes(x));
      if (APP_ROLE_PERMISSIONS[g.role].includes(perm) || extra.includes(perm)) via = 'app_grant';
    }
  }
  if (!via) return { allowed: false, reason: 'permission_missing', ...base };
  if (stale) return { allowed: false, reason: 'stale_state', ...base };
  return { allowed: true, via, accountId: facts.accountId, role: m.role, versions: facts.versions };
}

interface FactsRow {
  account_id: string | null; kind: string | null; status: string | null; authz_version: number | null;
  ownership_version: number | null; access_version: number | null;
  m_role: string | null; m_status: string | null; m_generation: number | null;
  g_role?: string | null; g_extra?: string | null; g_generation?: number | null; g_expires_at?: number | null;
}

function toFacts(resource: Resource, row: FactsRow | null): Facts {
  if (!row) {
    return { found: false, resource, accountId: null, accountKind: null, accountStatus: null, versions: { authz: 0, ownership: null, access: null }, membership: null, grant: null };
  }
  let extra: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.g_extra ?? '[]');
    if (Array.isArray(parsed)) extra = parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* an unparseable list grants nothing */ }
  return {
    found: true,
    resource,
    accountId: (row.account_id as AccountId | null) ?? null,
    accountKind: (row.kind as AccountKind | null) ?? null,
    accountStatus: row.status,
    versions: { authz: row.authz_version ?? 0, ownership: row.ownership_version, access: row.access_version },
    membership: row.m_role !== null && row.m_status !== null ? { role: row.m_role, status: row.m_status, generation: row.m_generation ?? 0 } : null,
    grant: row.g_role ? { role: row.g_role, extra, generation: row.g_generation ?? -1, expiresAt: row.g_expires_at ?? null } : null,
  };
}

const ACCOUNT_FACTS = `
  SELECT ac.id AS account_id, ac.kind, ac.status, ac.authz_version, NULL AS ownership_version, NULL AS access_version,
         m.role AS m_role, m.status AS m_status, m.generation AS m_generation
    FROM accounts ac
    LEFT JOIN account_memberships m ON m.account_id = ac.id AND m.user_id = ?2
   WHERE ac.id = ?1`;

const APP_FACTS = `
  SELECT a.owner_account_id AS account_id, ac.kind, ac.status, ac.authz_version, a.ownership_version, a.access_version,
         m.role AS m_role, m.status AS m_status, m.generation AS m_generation,
         g.role AS g_role, g.extra_permissions AS g_extra, g.membership_generation AS g_generation, g.expires_at AS g_expires_at
    FROM apps a
    LEFT JOIN accounts ac ON ac.id = a.owner_account_id
    LEFT JOIN account_memberships m ON m.account_id = a.owner_account_id AND m.user_id = ?2
    LEFT JOIN app_access_grants g ON g.app_id = a.id AND g.user_id = ?2 AND g.revoked_at IS NULL
   WHERE a.id = ?1`;

/** Read the facts for a decision from the D1 primary. A failed read throws; callers must treat that as a denial. */
async function loadFacts(db: D1Database, resource: Resource, userId: UserId): Promise<Facts> {
  const id = resource.kind === 'account' ? resource.accountId : resource.appId;
  const row = await db.prepare(resource.kind === 'account' ? ACCOUNT_FACTS : APP_FACTS).bind(id, userId).first<FactsRow>();
  return toFacts(resource, row);
}

/** Load and decide. A failed authority lookup denies (fail closed), it never broadens. */
export async function authorize(
  db: D1Database, principal: Principal, resource: Resource, perm: Permission, expect: Expectations = {},
): Promise<Decision> {
  try {
    return decide(principal, perm, await loadFacts(db, resource, principal.userId), expect);
  } catch {
    return { allowed: false, reason: 'not_found' };
  }
}

// ---------------------------------------------------------------------------
// Shadow mode: compare the new decision with the legacy one, classify every divergence.
// ---------------------------------------------------------------------------

/** Legacy `requireAppAccess(minRole)` approximated as the permission a caller at that rank needs. */
export const LEGACY_MIN_ROLE_PERMISSION: Readonly<Record<string, Permission>> = {
  viewer: 'app.read',
  po: 'app.tickets.write',
  developer: 'app.source.write',
  admin: 'app.access.manage',
  owner: 'app.secrets.manage',
};

export type DivergenceClass =
  | 'match'
  | 'not_backfilled' // legacy allowed; the app has no owning account yet (expected until T02 backfill runs)
  | 'legacy_only_allow' // legacy allowed, new denied: a missing compatibility mapping. Must be fixed before cutover.
  | 'new_only_allow'; // new allowed, legacy denied: an UNINTENDED EXPANSION. Blocks cutover.

export function classifyDivergence(legacyAllowed: boolean, decision: Decision): DivergenceClass {
  if (legacyAllowed === decision.allowed) return 'match';
  if (legacyAllowed) return !decision.allowed && decision.reason === 'no_owner_account' ? 'not_backfilled' : 'legacy_only_allow';
  return 'new_only_allow';
}
