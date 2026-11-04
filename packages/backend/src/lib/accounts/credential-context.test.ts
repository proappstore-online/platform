import { describe, expect, it } from 'vitest';
import { asAppId } from './contract.js';
import { buildCredentialContextClaim, parseCredentialContext } from './credential-context.js';

describe('parseCredentialContext: fails closed', () => {
  it('rejects a missing claim', () => expect(parseCredentialContext(undefined)).toBeNull());
  it.each([null, 'x', 1, [], true])('rejects a non-object claim %p', (v) => expect(parseCredentialContext(v as any)).toBeNull());
  it('rejects an unknown version', () => expect(parseCredentialContext({ v: 2, kind: 'first_party_session' })).toBeNull());
  it('rejects an unknown kind', () => expect(parseCredentialContext({ v: 1, kind: 'super_admin' })).toBeNull());
  it('rejects app_bound with no appId', () => expect(parseCredentialContext({ v: 1, kind: 'app_bound' })).toBeNull());
  it('rejects app_bound with an empty appId', () => expect(parseCredentialContext({ v: 1, kind: 'app_bound', appId: '' })).toBeNull());
  it('rejects a non-app-bound kind carrying an appId', () => {
    expect(parseCredentialContext({ v: 1, kind: 'first_party_session', appId: 'sneaky' })).toBeNull();
    expect(parseCredentialContext({ v: 1, kind: 'workload_session', appId: 'sneaky' })).toBeNull();
  });
});

describe('parseCredentialContext: accepts the versioned shape', () => {
  it('first_party_session, no appId', () => expect(parseCredentialContext({ v: 1, kind: 'first_party_session' })).toEqual({ v: 1, kind: 'first_party_session', appId: null }));
  it('workload_session, no appId', () => expect(parseCredentialContext({ v: 1, kind: 'workload_session' })).toEqual({ v: 1, kind: 'workload_session', appId: null }));
  it('app_bound carries its branded appId', () => expect(parseCredentialContext({ v: 1, kind: 'app_bound', appId: 'myapp' })).toEqual({ v: 1, kind: 'app_bound', appId: asAppId('myapp') }));
});

describe('buildCredentialContextClaim', () => {
  it('round-trips first_party_session and workload_session', () => {
    for (const kind of ['first_party_session', 'workload_session'] as const) {
      expect(parseCredentialContext(buildCredentialContextClaim(kind))).toEqual({ v: 1, kind, appId: null });
    }
  });
  it('round-trips app_bound with its appId', () => {
    const claim = buildCredentialContextClaim('app_bound', asAppId('myapp'));
    expect(claim).toEqual({ v: 1, kind: 'app_bound', appId: 'myapp' });
    expect(parseCredentialContext(claim)).toEqual({ v: 1, kind: 'app_bound', appId: asAppId('myapp') });
  });
  it('refuses to build app_bound with no appId', () => {
    expect(() => buildCredentialContextClaim('app_bound')).toThrow();
  });
});
