import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintMigration } from '../migration-lint.js';
import {
  ACCOUNT_ROLES, ACCOUNT_ROLE_PERMISSIONS, APP_ROLES, APP_ROLE_PERMISSIONS, GATE_CATEGORIES, GATE_CLASSIFICATION,
  INVITABLE_ROLES, LEGACY_TEAM_ROLE_TO_APP_ROLE, MANAGEABLE_TARGET_ROLES, PERMISSIONS, accountRoleHas, asAppId,
  assignableAppRoles, credentialMayExercise, isGovernance, type AccountRole, type Permission,
} from './contract.js';

const root = join(import.meta.dirname, '../../../../..');

describe('role and permission contract (ADR-013)', () => {
  it('every role and permission named in a map is a declared one', () => {
    for (const r of ACCOUNT_ROLES) for (const p of ACCOUNT_ROLE_PERMISSIONS[r]) expect(PERMISSIONS).toContain(p);
    for (const r of APP_ROLES) for (const p of APP_ROLE_PERMISSIONS[r]) expect(PERMISSIONS).toContain(p);
  });

  it('no account or app role can approve platform runtime trust', () => {
    for (const r of ACCOUNT_ROLES) expect(ACCOUNT_ROLE_PERMISSIONS[r]).not.toContain('platform.runtime.approve');
    for (const r of APP_ROLES) expect(APP_ROLE_PERMISSIONS[r]).not.toContain('platform.runtime.approve');
  });

  // The design's §3 table, row by row, for the account roles.
  const cases: [AccountRole, Permission, boolean][] = [
    ['owner', 'app.transfer', true], ['owner', 'app.delete', true], ['owner', 'account.delete', true], ['owner', 'account.owner.promote', true], ['owner', 'account.billing.manage', true],
    ['admin', 'app.source.write', true], ['admin', 'app.data.manage', true], ['admin', 'app.secrets.manage', true], ['admin', 'app.access.manage', true], ['admin', 'app.publish', true],
    ['admin', 'app.transfer', false], ['admin', 'app.delete', false], ['admin', 'account.delete', false], ['admin', 'account.owner.promote', false], ['admin', 'account.billing.manage', false],
    ['billing_manager', 'account.billing.manage', true], ['billing_manager', 'app.read', false], ['billing_manager', 'app.source.write', false], ['billing_manager', 'app.data.manage', false], ['billing_manager', 'app.secrets.manage', false], ['billing_manager', 'account.members.manage', false],
    ['member', 'app.read', false], ['member', 'account.read', true], ['member', 'account.members.read', false],
    ['guest', 'app.read', false], ['guest', 'account.read', false], ['guest', 'account.members.invite', false],
  ];
  it.each(cases)('%s %s -> %s', (role, perm, expected) => expect(accountRoleHas(role, perm)).toBe(expected));

  it('an unknown role holds nothing', () => expect(accountRoleHas('superuser', 'app.read')).toBe(false));

  it('a new developer assignment has no raw SQL; the legacy developer bundle keeps it', () => {
    expect(APP_ROLE_PERMISSIONS.developer).not.toContain('app.data.manage');
    expect(APP_ROLE_PERMISSIONS.app_legacy_developer).toContain('app.data.manage');
    expect(LEGACY_TEAM_ROLE_TO_APP_ROLE.developer).toBe('app_legacy_developer');
  });

  it('the legacy owner bundle keeps app management but gains no transfer or account authority', () => {
    const owner = APP_ROLE_PERMISSIONS.app_legacy_owner;
    expect(owner).toContain('app.secrets.manage');
    expect(owner).not.toContain('app.transfer');
    expect(owner.some((p) => p.startsWith('account.'))).toBe(false);
  });

  it('the legacy admin bundle keeps what admin can do today and gains no owner-only rights', () => {
    expect(LEGACY_TEAM_ROLE_TO_APP_ROLE.admin).toBe('app_legacy_admin');
    const admin = APP_ROLE_PERMISSIONS.app_legacy_admin;
    for (const p of ['app.access.manage', 'app.data.manage', 'app.source.write'] as const) expect(admin).toContain(p);
    for (const p of ['app.secrets.manage', 'app.publish', 'app.delete', 'app.transfer'] as const) expect(admin).not.toContain(p);
  });

  it('product owner and viewer carry no code, data or secret rights', () => {
    for (const r of ['product_owner', 'viewer'] as const) {
      for (const p of ['app.source.write', 'app.data.manage', 'app.secrets.manage', 'app.publish'] as const) expect(APP_ROLE_PERMISSIONS[r]).not.toContain(p);
    }
    expect(APP_ROLE_PERMISSIONS.product_owner).toContain('app.tickets.write');
    expect(APP_ROLE_PERMISSIONS.viewer).not.toContain('app.tickets.write');
  });

  it('owners are never invitable and admins cannot invite or manage peers', () => {
    for (const r of ACCOUNT_ROLES) expect(INVITABLE_ROLES[r]).not.toContain('owner');
    expect(INVITABLE_ROLES.admin).not.toContain('admin');
    expect(MANAGEABLE_TARGET_ROLES.admin).not.toContain('owner');
    expect(MANAGEABLE_TARGET_ROLES.admin).not.toContain('admin');
    expect(MANAGEABLE_TARGET_ROLES.owner).toContain('owner');
  });

  it('an app admin only assigns lower app roles', () => {
    expect(assignableAppRoles('app_admin')).toEqual(['developer', 'product_owner', 'viewer']);
    expect(assignableAppRoles('developer')).toEqual([]);
  });
});

describe('credential scope', () => {
  const a = asAppId('app-a');
  const b = asAppId('app-b');
  it('a first-party session may exercise anything its person may', () => expect(credentialMayExercise('first_party_session', 'account.members.manage', null, null)).toBe(true));
  it('a workload session is denied governance, ownership and platform trust', () => {
    for (const p of PERMISSIONS.filter(isGovernance)) expect(credentialMayExercise('workload_session', p, null, null)).toBe(false);
    expect(credentialMayExercise('workload_session', 'app.read', a, null)).toBe(true);
  });
  it('an app-bound credential reaches only its own app and never governance', () => {
    expect(credentialMayExercise('app_bound', 'app.source.write', a, a)).toBe(true);
    expect(credentialMayExercise('app_bound', 'app.source.write', b, a)).toBe(false);
    expect(credentialMayExercise('app_bound', 'app.source.write', null, a)).toBe(false);
    expect(credentialMayExercise('app_bound', 'app.source.write', a, null)).toBe(false);
    for (const p of PERMISSIONS.filter(isGovernance)) expect(credentialMayExercise('app_bound', p, a, a)).toBe(false);
  });
});

describe('migration 0124', () => {
  const sql = readFileSync(join(root, 'migrations/0124_team_accounts.sql'), 'utf8');
  it('passes the additive-only deploy lint', () => {
    const { error } = lintMigration(sql);
    expect(error, error?.reason).toBeNull();
  });
  it('writes no rows', () => expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/im));
});

// Every file that still decides access from creator_id, owner_id or team_members must be classified
// (T01), so a new gate cannot be added without someone deciding what it is.
describe('ownership gate classification', () => {
  const PATTERNS: Record<string, RegExp> = {
    backend: /creator_id|requireAppOwner|requireAppAccess|isAdminId/,
    other: /creator_id|owner_id|team_role|team_members|verifyAppOwnership/,
  };
  const SKIP = /(\.test\.|\.spec\.|__tests__|__fixtures__|[\\/]generated[\\/]|openapi-spec\.ts|node_modules|[\\/]dist[\\/])/;
  // The account modules themselves; their reads of legacy columns are the backfill and shadow comparison.
  const OWN = /packages\/backend\/src\/(lib\/accounts\/|routes\/accounts\.ts)/;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      if (SKIP.test(p)) return [];
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(e) ? [p] : [];
    });
  }
  const files = [
    ...walk(join(root, 'packages/backend/src')).filter((f) => PATTERNS.backend!.test(readFileSync(f, 'utf8'))),
    ...['admin', 'agent-teams', 'build-core', 'data-worker', 'mcp'].flatMap((pkg) => walk(join(root, 'packages', pkg, 'src')).filter((f) => PATTERNS.other!.test(readFileSync(f, 'utf8')))),
  ].map((f) => relative(root, f).replaceAll('\\', '/')).filter((f) => !OWN.test(f));

  it('classifies every source file that uses an ownership gate', () => {
    expect(files.length).toBeGreaterThan(50);
    const missing = files.filter((f) => !(f in GATE_CLASSIFICATION));
    expect(missing, `unclassified gate files: ${missing.join(', ')}`).toEqual([]);
  });
  it('has no stale entries and only declared categories', () => {
    const live = new Set(files);
    expect(Object.keys(GATE_CLASSIFICATION).filter((f) => !live.has(f))).toEqual([]);
    for (const e of Object.values(GATE_CLASSIFICATION)) expect(GATE_CATEGORIES).toContain(e.category);
  });
});
