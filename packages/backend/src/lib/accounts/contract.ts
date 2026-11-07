/**
 * The team-accounts authorization contract (#534 T01, ADR-013).
 *
 * Roles and permissions are DATA, shared by the resolver (authorize.ts), the routes and the tests,
 * so the matrix in docs/adr/013-team-accounts.md has exactly one implementation. Nothing here
 * touches D1 or a request. Roles are NOT a numeric rank: each is a named permission set, so product
 * work and money are not one privilege ladder.
 *
 * Nothing here changes ADR-009's runtime policy. `platform.runtime.approve` belongs to no account role.
 */

/** Branded ids: a team account id can never be passed where a user id is expected (design §9). */
export type UserId = string & { readonly __brand: 'UserId' };
export type AccountId = string & { readonly __brand: 'AccountId' };
export type AppId = string & { readonly __brand: 'AppId' };

export const asUserId = (v: string): UserId => v as UserId;
export const asAccountId = (v: string): AccountId => v as AccountId;
export const asAppId = (v: string): AppId => v as AppId;

const ACCOUNT_KINDS = ['personal', 'team'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** `provisioning` is the non-active state a team has until its first owner exists (design §4). */
const ACCOUNT_STATUSES = ['provisioning', 'active', 'suspended', 'deleting', 'deleted'] as const;
type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_ROLES = ['owner', 'admin', 'billing_manager', 'member', 'guest'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

const MEMBERSHIP_STATUSES = ['active', 'removed'] as const;
type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** Roles an app assignment can carry. `app_legacy_*` are compatibility bundles, never assignable by new grants. */
export const APP_ROLES = ['app_admin', 'developer', 'product_owner', 'viewer', 'app_legacy_owner', 'app_legacy_admin', 'app_legacy_developer'] as const;
export type AppRole = (typeof APP_ROLES)[number];
/** The app roles a human may newly assign. */
const ASSIGNABLE_APP_ROLES = ['app_admin', 'developer', 'product_owner', 'viewer'] as const;

export const PERMISSIONS = [
  // App (publisher) permissions.
  'app.read', // metadata, source, sanitized operational views
  'app.tickets.read',
  'app.tickets.write',
  'app.source.write', // source changes and normal deploy
  'app.data.manage', // arbitrary SQL and schema migration
  'app.secrets.manage', // secrets, connector bindings, webhook configuration
  'app.agents.run', // run/pause build agents within an approved budget
  'app.access.manage', // app assignments
  'app.publish', // storefront publication and domains
  'app.billing.summary.read',
  'app.transfer',
  'app.delete',
  // Account governance.
  'account.read',
  'account.settings.update',
  'account.members.read',
  'account.members.invite',
  'account.members.manage',
  'account.owner.promote',
  'account.billing.manage', // payment method, spending ceiling
  'account.delete',
  'account.audit.read',
  // Platform trust. No account role holds this.
  'platform.runtime.approve',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const p = (...v: Permission[]): readonly Permission[] => v;

const APP_READ = p('app.read', 'app.tickets.read', 'app.tickets.write');
const APP_PUBLISHER = p(
  'app.read', 'app.tickets.read', 'app.tickets.write', 'app.source.write', 'app.data.manage',
  'app.secrets.manage', 'app.agents.run', 'app.access.manage', 'app.publish',
);

/**
 * What each account role may do on the ACCOUNT and, for owners/admins, on every app the account owns
 * (design §3: owners and admins have account-wide publisher access). Member and guest hold nothing
 * on apps without an explicit assignment; a billing manager holds no code, data or connector access.
 */
export const ACCOUNT_ROLE_PERMISSIONS: Readonly<Record<AccountRole, readonly Permission[]>> = {
  owner: [
    ...APP_PUBLISHER, 'app.billing.summary.read', 'app.transfer', 'app.delete',
    ...p('account.read', 'account.settings.update', 'account.members.read', 'account.members.invite',
      'account.members.manage', 'account.owner.promote', 'account.billing.manage', 'account.delete', 'account.audit.read'),
  ],
  admin: [
    ...APP_PUBLISHER, 'app.billing.summary.read',
    ...p('account.read', 'account.settings.update', 'account.members.read', 'account.members.invite',
      'account.members.manage', 'account.audit.read'),
  ],
  billing_manager: p('account.read', 'account.billing.manage', 'app.billing.summary.read'),
  member: p('account.read'),
  guest: p(),
};

/** What an app assignment grants, on that one app. `app.data.manage` for a developer needs the explicit grant below. */
export const APP_ROLE_PERMISSIONS: Readonly<Record<AppRole, readonly Permission[]>> = {
  app_admin: [...APP_PUBLISHER],
  developer: p('app.read', 'app.tickets.read', 'app.tickets.write', 'app.source.write', 'app.agents.run'),
  product_owner: p('app.read', 'app.tickets.read', 'app.tickets.write'),
  viewer: p('app.read', 'app.tickets.read'),
  /**
   * Compatibility bundle for an existing app-level `team_members.role = 'owner'` (design §3): the
   * management powers requireAppOwner routes grant today, but NOT `app.transfer` (transfer is
   * creator-only today) and nothing account-wide. T05 verifies the exact set against each route.
   */
  app_legacy_owner: [...APP_PUBLISHER, 'app.delete'],
  /**
   * Today's app-level `admin` manages the team, invitations and roles and can use raw SQL (it outranks
   * developer), but fails every requireAppOwner route: no secrets, connectors, webhooks, domains or
   * publication. The new `app_admin` may do those (design §3), so backfilling legacy admins to it would
   * widen them. Shadow mode over a personal-account fixture found exactly this.
   */
  app_legacy_admin: p('app.read', 'app.tickets.read', 'app.tickets.write', 'app.source.write', 'app.agents.run', 'app.data.manage', 'app.access.manage'),
  /** Existing developers already have raw SQL today: preserved, recorded as `legacy_developer_data_access`. */
  app_legacy_developer: p('app.read', 'app.tickets.read', 'app.tickets.write', 'app.source.write', 'app.agents.run', 'app.data.manage'),
};

/** Today's app-level `team_members.role` mapped to its compatibility app role. `po`/`viewer` carry no extra rights. */
export const LEGACY_TEAM_ROLE_TO_APP_ROLE: Readonly<Record<string, AppRole>> = {
  owner: 'app_legacy_owner',
  admin: 'app_legacy_admin',
  developer: 'app_legacy_developer',
  po: 'product_owner',
  viewer: 'viewer',
};

/** Why a compatibility grant exists, stored on the grant row and shown in the migration preview. */
const LEGACY_GRANT_REASONS = ['legacy_developer_data_access', 'legacy_app_owner', 'legacy_app_collaborator'] as const;
export type LegacyGrantReason = (typeof LEGACY_GRANT_REASONS)[number];

/** Explicit extra permission an assignment may carry beyond its role. Only `app.data.manage` exists in v1. */
export const EXPLICIT_GRANTABLE: readonly Permission[] = ['app.data.manage'];

// ---------------------------------------------------------------------------
// Credentials. Governance needs a first-party control-plane credential (design §3).
// ---------------------------------------------------------------------------

const CREDENTIAL_KINDS = [
  'first_party_session', // a session minted for a human control-plane sign-in, never bound to one app
  'workload_session', // a session minted without a human present (e.g. oidc-e2e), or one with no verified context
  'app_bound', // a credential issued to one app: app-origin session, end-user app token, app-scoped MCP grant
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export const isCredentialKind = (v: unknown): v is CredentialKind => typeof v === 'string' && (CREDENTIAL_KINDS as readonly string[]).includes(v);

/** Permissions a credential kind may EVER exercise, intersected with the person's rights. */
export function credentialMayExercise(kind: CredentialKind, perm: Permission, resourceAppId: AppId | null, boundAppId: AppId | null): boolean {
  if (kind === 'first_party_session') return true;
  // Workload sessions are non-interactive: no governance, no money, no ownership.
  if (kind === 'workload_session') return !isGovernance(perm);
  // An app-bound credential reaches only its own app, and never governance.
  if (isGovernance(perm)) return false;
  return resourceAppId !== null && boundAppId !== null && resourceAppId === boundAppId;
}

/** Account governance, money, ownership and platform trust: never reachable by a non-first-party credential. */
export function isGovernance(perm: Permission): boolean {
  return perm.startsWith('account.') || perm === 'app.transfer' || perm === 'app.delete' || perm === 'platform.runtime.approve';
}

// ---------------------------------------------------------------------------
// Role ceilings for membership changes (design §3, §5).
// ---------------------------------------------------------------------------

/** Roles an inviter may offer. Owner is never invited: an existing member is promoted (recent auth). */
export const INVITABLE_ROLES: Readonly<Record<AccountRole, readonly AccountRole[]>> = {
  owner: ['admin', 'billing_manager', 'member', 'guest'],
  admin: ['billing_manager', 'member', 'guest'],
  billing_manager: [],
  member: [],
  guest: [],
};

/** Target roles an actor may change or remove. Admins never touch owners or peers. */
export const MANAGEABLE_TARGET_ROLES: Readonly<Record<AccountRole, readonly AccountRole[]>> = {
  owner: ['owner', 'admin', 'billing_manager', 'member', 'guest'],
  admin: ['billing_manager', 'member', 'guest'],
  billing_manager: [],
  member: [],
  guest: [],
};

/** App roles an app-level assigner may hand out: an app admin only assigns lower roles (design §3). */
export function assignableAppRoles(actor: 'account_owner_or_admin' | AppRole): readonly AppRole[] {
  if (actor === 'account_owner_or_admin') return ASSIGNABLE_APP_ROLES;
  if (actor === 'app_admin') return ['developer', 'product_owner', 'viewer'];
  return [];
}

export const isAccountRole = (v: unknown): v is AccountRole => typeof v === 'string' && (ACCOUNT_ROLES as readonly string[]).includes(v);
export const isAppRole = (v: unknown): v is AppRole => typeof v === 'string' && (APP_ROLES as readonly string[]).includes(v);

/** True when the account role grants `perm` (an unknown role grants nothing). */
export function accountRoleHas(role: string, perm: Permission): boolean {
  return isAccountRole(role) && ACCOUNT_ROLE_PERMISSIONS[role].includes(perm);
}

// ---------------------------------------------------------------------------
// Classification of every current ownership gate (inventory, ADR-013 §Gate classification).
// ---------------------------------------------------------------------------

export const GATE_CATEGORIES = [
  'live_authorization', // decides today whether the caller may act: T05 moves it to authorize()
  'projection', // a list/directory/index derived from ownership
  'historical_attribution', // who created it: stays as attribution, never authority after cutover
  'provisioning_actor', // the actor on a creation receipt / rate limit / claim
  'end_user_business', // an app's own business roles; not publisher authority
  'personal_record', // a per-user record keyed by user id (profile, own submission); stays user-scoped
] as const;
type GateCategory = (typeof GATE_CATEGORIES)[number];

interface GateEntry {
  category: GateCategory;
  /** `inspected` = the matching lines were read for this classification; `inventory` = from the file's role in the inventory, T05 must re-read. */
  basis: 'inspected' | 'inventory';
  note: string;
}

const live = (note: string): GateEntry => ({ category: 'live_authorization', basis: 'inspected', note });
const proj = (note: string): GateEntry => ({ category: 'projection', basis: 'inspected', note });
const hist = (note: string): GateEntry => ({ category: 'historical_attribution', basis: 'inspected', note });
const prov = (note: string): GateEntry => ({ category: 'provisioning_actor', basis: 'inspected', note });
const pers = (note: string): GateEntry => ({ category: 'personal_record', basis: 'inspected', note });
const OWNER_ONLY = 'requireAppOwner: owner-level publisher action';

/** Keys are repo-relative paths. A test fails when a source file using an ownership gate is missing here. */
export const GATE_CLASSIFICATION: Readonly<Record<string, GateEntry>> = {
  'packages/backend/src/lib/auth.ts': live('the gate itself: creator_id, team_members, platform-admin bypass'),
  'packages/backend/src/lib/app-worker-host.ts': live('disableAppWorker persists the administrator kill switch; callers establish owner/admin authority before invoking it'),
  'packages/backend/src/lib/google-calendar-policy.ts': live('reads the publisher identity for the consent snapshot; this grants no publisher-management permission'),
  'packages/backend/src/lib/google-calendar-oauth.ts': live('atomically refuses a pending personal consent request after its publisher changes; this is a lifecycle guard, not an owner-role grant'),
  'packages/backend/src/lib/native-companion.ts': live('invalidates personal native grants when the recipient app changes publisher; grants no publisher-management authority'),
  'packages/backend/src/lib/operation-log.ts': live('owner flag decides who sees an operation'),
  'packages/backend/src/lib/operator-audit-marks.ts': live('wraps requireAppOwner and remembers the owner for the refusal audit'),
  'packages/backend/src/lib/public-team.ts': live('own saved preferences require publisher, current member or active promoter; public projection separately requires opt-in and current membership; owner moderation uses requireAppOwner'),
  'packages/backend/src/lib/provision-data.ts': hist('INSERT apps.creator_id at provisioning; dev_profiles seed'),
  'packages/backend/src/lib/provision-operation.ts': prov('creator_id on the provisioning receipt'),
  'packages/backend/src/lib/visibility.ts': live('private-app visibility keyed on creator_id'),
  'packages/backend/src/routes/actions.ts': live('callerIsAppTeam: team access to staged actions'),
  'packages/backend/src/routes/alerts.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/analytics-stats-routes.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/analytics.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/app-billing-account.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/app-directory.ts': proj('directory is_owner and owned-app list'),
  'packages/backend/src/routes/app-workers.ts': live('owner and verified repository deployment gates; self-service eligibility, administrator kill switch, and prototype fallback when disabled'),
  'packages/backend/src/routes/apps.ts': proj('owned/team app lists; the PUT owner check at ~214 is live authorization'),
  'packages/backend/src/routes/connectors.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/data-import.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/delete-app-account.ts': live('requireAppAccess for acting on another user; end-user erasure itself is end_user_business'),
  'packages/backend/src/routes/deploy.ts': live('owner gate; the creator_id SELECT at ~446 is deploy provenance (historical)'),
  'packages/backend/src/routes/domains.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/email.ts': live('creator_id === user.id decides who may send app email'),
  'packages/backend/src/routes/endpoints.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/engagements.ts': pers('dev_profiles.creator_id: a developer-marketplace profile keyed by user'),
  'packages/backend/src/routes/enquiries.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/hooks.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/invites.ts': live('app invites: requireAppAccess admin/developer'),
  'packages/backend/src/routes/listings.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/logs.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/marketing-deploy.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/notifications.ts': live('creator_id === user.id decides who may notify the app audience'),
  'packages/backend/src/routes/native.ts': live('binds native end-user consent, ingestion and reads to the current publisher; device credentials have no creator or admin rights'),
  'packages/backend/src/routes/oidc-session.ts': live('isAdminId gate on minting e2e sessions (platform trust, not account authority)'),
  'packages/backend/src/routes/ownership.ts': live('creator-only transfer/recovery; T07 turns it into account-to-account transfer'),
  'packages/backend/src/routes/pags.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/promoters.ts': live('requireAppOwner for the owner lifecycle routes; enrollment is a person-session relationship that grants no publisher, team or admin right'),
  'packages/backend/src/routes/contributions.ts': live('requireAppAccess viewer for reads (a private team stays private); requireAppOwner for refresh; code-activity metrics only, no role, ownership or payout effect'),
  'packages/backend/src/routes/referrals.ts': live('requireAppOwner for review and correction; the claim is the referred person own mediated, app-bound session and grants no right'),
  'packages/backend/src/routes/provision.ts': prov('claim check: creator_id vs the provisioning actor'),
  'packages/backend/src/routes/provisioning-plans.ts': live('plan state owner/other from creator_id and team role'),
  'packages/backend/src/routes/qa.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/reliability.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/roles.ts': live('requireAppAccess admin managing end-user app roles; the roles themselves are end_user_business'),
  'packages/backend/src/routes/scheduled-runs.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/secrets-allowlist-crud.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/secrets-crud.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/secrets.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/services.ts': pers('dev_profiles.creator_id: a developer-marketplace profile keyed by user'),
  'packages/backend/src/routes/sms.ts': live('creator_id !== user.id decides who may send app SMS'),
  'packages/backend/src/routes/sourcemaps.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/storage.ts': live('requireAppOwner / requireAppAccess admin|viewer'),
  'packages/backend/src/routes/submissions-helpers.ts': hist('row mapping of submissions.creator_id'),
  'packages/backend/src/routes/submissions-review.ts': prov('provisions on behalf of the submission creator'),
  'packages/backend/src/routes/submissions.ts': pers('a submission belongs to the user who filed it'),
  'packages/backend/src/routes/teams.ts': live('app-level team routes: requireAppAccess admin, TEAM_ROLES rank, creator/admin inviter check; public profile self-service is a current-member check, its owner moderation view is requireAppOwner'),
  'packages/backend/src/routes/telemetry-health.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/tools.ts': live('requireAppOwner on tool/role admin; app role names are end_user_business'),
  'packages/backend/src/routes/usage.ts': live('requireAppOwner; the ownedApps query at ~417 is a projection'),
  'packages/backend/src/routes/visibility.ts': live(OWNER_ONLY),
  'packages/backend/src/routes/webhooks-config.ts': live(OWNER_ONLY),
  'packages/backend/src/types.ts': hist('the apps row type'),
  // Other services: classified from the inventory, not yet line-by-line. T05 re-reads each before replacing the check.
  'packages/admin/src/index.ts': { category: 'provisioning_actor', basis: 'inventory', note: 'admin provisioning entry' },
  'packages/admin/src/provision-guard.ts': { category: 'live_authorization', basis: 'inventory', note: 'owner guard on provisioning' },
  'packages/agent-teams/src/agent-runner.ts': { category: 'live_authorization', basis: 'inventory', note: 'resolves the project owner\'s personal API key (funding)' },
  'packages/agent-teams/src/architect-chat.ts': { category: 'live_authorization', basis: 'inventory', note: 'project role gate' },
  'packages/agent-teams/src/deploy-stage.ts': { category: 'live_authorization', basis: 'inventory', note: 'deploy as the project owner' },
  'packages/agent-teams/src/index.ts': { category: 'live_authorization', basis: 'inventory', note: 'router: project access and creation' },
  'packages/agent-teams/src/po-chat.ts': { category: 'live_authorization', basis: 'inventory', note: 'project role gate' },
  'packages/agent-teams/src/project-access.ts': { category: 'live_authorization', basis: 'inventory', note: 'DO access; owner_id is a projection of D1' },
  'packages/agent-teams/src/project-reports.ts': { category: 'projection', basis: 'inventory', note: 'owner_id in reports' },
  'packages/agent-teams/src/project-settings.ts': { category: 'live_authorization', basis: 'inventory', note: 'settings gate' },
  'packages/agent-teams/src/project-test-host.ts': { category: 'projection', basis: 'inventory', note: 'test host owner field' },
  'packages/agent-teams/src/qa-chat.ts': { category: 'live_authorization', basis: 'inventory', note: 'project role gate' },
  'packages/agent-teams/src/store.ts': { category: 'projection', basis: 'inventory', note: 'ProjectDO owner_id copy' },
  'packages/agent-teams/src/templates/organization.ts': { category: 'end_user_business', basis: 'inventory', note: 'template example app roles' },
  'packages/agent-teams/src/templates/realtime.ts': { category: 'end_user_business', basis: 'inventory', note: 'template example app roles' },
  'packages/build-core/src/index.ts': { category: 'live_authorization', basis: 'inventory', note: 're-export of ownership' },
  'packages/build-core/src/ownership.ts': { category: 'live_authorization', basis: 'inventory', note: 'verifyAppOwnership used by workers' },
  'packages/build-core/src/provision-rate-limit.ts': { category: 'provisioning_actor', basis: 'inventory', note: 'rate-limit key' },
  'packages/data-worker/src/index.ts': { category: 'live_authorization', basis: 'inventory', note: 'raw SQL/migration authorization via /v1/apps' },
  'packages/mcp/src/index.ts': { category: 'live_authorization', basis: 'inventory', note: 'MCP tool ownership' },
  'packages/mcp/src/provisioning-workflow.ts': { category: 'live_authorization', basis: 'inventory', note: 'ownership cached 60 s: must not survive T05' },
};
