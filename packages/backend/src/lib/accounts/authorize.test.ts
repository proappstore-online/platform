import { describe, expect, it } from 'vitest';
import { asAccountId, asAppId, asUserId, type AccountRole } from './contract.js';
import { classifyDivergence, decide, type Facts, type Principal } from './authorize.js';

const acct = asAccountId('acct1');
const app = asAppId('app1');
const alice: Principal = { userId: asUserId('gh:alice'), credential: 'first_party_session' };

const base = (over: Partial<Facts> = {}): Facts => ({
  found: true, resource: { kind: 'app', appId: app }, accountId: acct, accountKind: 'team', accountStatus: 'active',
  versions: { authz: 3, ownership: 2, access: 5 }, membership: { role: 'member', status: 'active', generation: 1 }, grant: null, ...over,
});
const member = (role: string, status = 'active', generation = 1) => ({ role, status, generation });
const grant = (role: string, over: Partial<NonNullable<Facts['grant']>> = {}) => ({ role, extra: [] as string[], generation: 1, expiresAt: null, ...over });

describe('decide: fail closed', () => {
  it('denies an unknown resource', () => expect(decide(alice, 'app.read', base({ found: false }))).toMatchObject({ allowed: false, reason: 'not_found' }));
  it('denies an app with no owning account (no creator fallback)', () => expect(decide(alice, 'app.read', base({ accountId: null }))).toMatchObject({ allowed: false, reason: 'no_owner_account' }));
  it.each(['provisioning', 'deleting', 'deleted', 'weird'])('denies an account in state %s', (s) => expect(decide(alice, 'app.read', base({ accountStatus: s, membership: member('owner') }))).toMatchObject({ allowed: false }));
  it('names a suspended account', () => expect(decide(alice, 'app.read', base({ accountStatus: 'suspended', membership: member('owner') }))).toMatchObject({ reason: 'account_suspended' }));
  it('denies a non-member, even one holding a grant', () => expect(decide(alice, 'app.read', base({ membership: null, grant: grant('app_admin') }))).toMatchObject({ reason: 'not_a_member' }));
  it('denies a removed member', () => expect(decide(alice, 'app.read', base({ membership: member('owner', 'removed') }))).toMatchObject({ reason: 'membership_removed' }));
  it('denies an unknown account role', () => expect(decide(alice, 'app.read', base({ membership: member('emperor') }))).toMatchObject({ reason: 'unknown_role' }));
  it('ignores a grant with an unknown role', () => expect(decide(alice, 'app.read', base({ grant: grant('wizard') }))).toMatchObject({ reason: 'permission_missing' }));
});

describe('decide: roles', () => {
  const owner = base({ membership: member('owner') });
  it('an owner has account-wide publisher rights on a team app', () => {
    for (const p of ['app.source.write', 'app.data.manage', 'app.transfer', 'app.delete'] as const) expect(decide(alice, p, owner)).toMatchObject({ allowed: true, via: 'account_role' });
  });
  it('an admin publishes but cannot transfer or delete', () => {
    const admin = base({ membership: member('admin') });
    expect(decide(alice, 'app.source.write', admin).allowed).toBe(true);
    expect(decide(alice, 'app.transfer', admin)).toMatchObject({ allowed: false, reason: 'permission_missing' });
    expect(decide(alice, 'app.delete', admin).allowed).toBe(false);
  });
  it('a billing manager has no code, data or connector access', () => {
    const bm = base({ membership: member('billing_manager') });
    for (const p of ['app.read', 'app.source.write', 'app.data.manage', 'app.secrets.manage'] as const) expect(decide(alice, p, bm).allowed).toBe(false);
    expect(decide(alice, 'app.billing.summary.read', bm).allowed).toBe(true);
  });
  it.each<[AccountRole]>([['member'], ['guest']])('%s without an assignment has no app rights', (r) => expect(decide(alice, 'app.read', base({ membership: member(r) })).allowed).toBe(false));
});

describe('decide: app grants', () => {
  it('a guest with a developer grant may write source but not raw SQL', () => {
    const f = base({ membership: member('guest'), grant: grant('developer') });
    expect(decide(alice, 'app.source.write', f)).toMatchObject({ allowed: true, via: 'app_grant' });
    expect(decide(alice, 'app.data.manage', f).allowed).toBe(false);
  });
  it('an explicit data.manage grant gives a developer raw SQL; no other extra is honoured', () => {
    expect(decide(alice, 'app.data.manage', base({ membership: member('guest'), grant: grant('developer', { extra: ['app.data.manage'] }) })).allowed).toBe(true);
    expect(decide(alice, 'app.secrets.manage', base({ membership: member('guest'), grant: grant('developer', { extra: ['app.secrets.manage'] }) })).allowed).toBe(false);
  });
  it('a grant from an earlier membership generation never applies (no resurrection)', () => {
    const f = base({ membership: member('guest', 'active', 2), grant: grant('app_admin', { generation: 1 }) });
    expect(decide(alice, 'app.read', f)).toMatchObject({ allowed: false, reason: 'permission_missing' });
  });
  it('an expired grant never applies', () => {
    const f = base({ membership: member('guest'), grant: grant('viewer', { expiresAt: 1000 }) });
    expect(decide(alice, 'app.read', f, {}, 2000).allowed).toBe(false);
    expect(decide(alice, 'app.read', f, {}, 500).allowed).toBe(true);
  });
  it('a grant never confers an account permission', () => {
    expect(decide(alice, 'account.members.manage', base({ resource: { kind: 'account', accountId: acct }, membership: member('guest'), grant: grant('app_admin') })).allowed).toBe(false);
  });
  it('a legacy owner grant may manage the app but not transfer it', () => {
    const f = base({ membership: member('guest'), grant: grant('app_legacy_owner') });
    expect(decide(alice, 'app.secrets.manage', f).allowed).toBe(true);
    expect(decide(alice, 'app.transfer', f).allowed).toBe(false);
  });
});

describe('decide: credentials and identity', () => {
  const owner = base({ membership: member('owner') });
  it('an app-bound credential cannot govern even when its person owns the account', () => {
    const p: Principal = { ...alice, credential: 'app_bound', boundAppId: app };
    expect(decide(p, 'account.members.manage', base({ resource: { kind: 'account', accountId: acct }, membership: member('owner') }))).toMatchObject({ reason: 'credential_scope' });
    expect(decide(p, 'app.source.write', owner).allowed).toBe(true);
  });
  it('an app-bound credential does not reach another app of the same team', () => {
    const p: Principal = { ...alice, credential: 'app_bound', boundAppId: asAppId('other') };
    expect(decide(p, 'app.source.write', owner)).toMatchObject({ reason: 'credential_scope' });
  });
  it('a workload session cannot transfer or delete', () => {
    const p: Principal = { ...alice, credential: 'workload_session' };
    expect(decide(p, 'app.transfer', owner).allowed).toBe(false);
    expect(decide(p, 'app.read', owner).allowed).toBe(true);
  });
  it('platform admin compatibility: app rights, no governance, no transfer, not when suspended', () => {
    const admin: Principal = { ...alice, platformAdmin: true };
    const none = base({ membership: null });
    expect(decide(admin, 'app.read', none)).toMatchObject({ allowed: true, via: 'platform_admin_compat' });
    expect(decide(admin, 'app.transfer', none).allowed).toBe(false);
    expect(decide(admin, 'account.members.manage', base({ resource: { kind: 'account', accountId: acct }, membership: null })).allowed).toBe(false);
    expect(decide(admin, 'app.read', base({ membership: null, accountStatus: 'suspended' })).allowed).toBe(false);
  });
});

describe('decide: version expectations', () => {
  const owner = base({ membership: member('owner') });
  it('matching versions allow', () => expect(decide(alice, 'app.read', owner, { authzVersion: 3, ownershipVersion: 2, accessVersion: 5 }).allowed).toBe(true));
  it.each([[{ authzVersion: 2 }], [{ ownershipVersion: 1 }], [{ accessVersion: 4 }]])('a stale %o is stale_state', (e) => expect(decide(alice, 'app.read', owner, e)).toMatchObject({ allowed: false, reason: 'stale_state' }));
});

describe('shadow classification', () => {
  const allow = decide(alice, 'app.read', base({ membership: member('owner') }));
  const deny = decide(alice, 'app.read', base({ membership: null }));
  it('matches', () => { expect(classifyDivergence(true, allow)).toBe('match'); expect(classifyDivergence(false, deny)).toBe('match'); });
  it('flags an unintended expansion', () => expect(classifyDivergence(false, allow)).toBe('new_only_allow'));
  it('separates an un-backfilled app from a missing mapping', () => {
    expect(classifyDivergence(true, decide(alice, 'app.read', base({ accountId: null })))).toBe('not_backfilled');
    expect(classifyDivergence(true, deny)).toBe('legacy_only_allow');
  });
});
