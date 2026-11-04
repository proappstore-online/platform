/**
 * The verified credential context (#535, ADR-013's T05 prerequisite).
 *
 * `lib/auth.ts`'s `requireUser` used to classify every session as `first_party_session` unless it
 * carried a `via` claim — but absence of `via` is not evidence of a first-party credential: an
 * end-user app token, an app-origin session and a re-minted app-scoped MCP grant all carry no `via`
 * either, and none of them is first-party. This module is the ONE place that turns a session's raw,
 * signed `cred` claim (`@proappstore/build-core`'s generic envelope) into the typed `CredentialKind` +
 * bound app id the resolver (`authorize.ts`) needs — and the only place allowed to decide what counts.
 *
 * Fails closed by construction: `parseCredentialContext` returns `null` for anything unversioned,
 * unparseable or carrying an unknown kind, and the caller (`lib/auth.ts`) treats `null` as "no verified
 * context" — never as first-party. There is no fallback to `via`, a header, a body field or an
 * account/app selection here, by design.
 */
import { asAppId, isCredentialKind, type AppId, type CredentialKind } from './contract.js';
import { CREDENTIAL_CONTEXT_VERSION, credentialContext as rawCredentialContext, type CredentialContextClaim } from '@proappstore/build-core';

export interface CredentialContext {
  readonly v: typeof CREDENTIAL_CONTEXT_VERSION;
  readonly kind: CredentialKind;
  /** Only set for `kind === 'app_bound'`. */
  readonly appId: AppId | null;
}

/**
 * Parse a session's raw `cred` claim. `null` for anything malformed, unversioned, carrying an
 * unknown kind, an `app_bound` claim with no (or an empty) `appId`, or a non-`app_bound` claim that
 * carries one — never guessed, never widened to the nearest known shape.
 */
export function parseCredentialContext(raw: CredentialContextClaim | undefined): CredentialContext | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== CREDENTIAL_CONTEXT_VERSION) return null;
  if (!isCredentialKind(raw.kind)) return null;
  if (raw.kind === 'app_bound') {
    if (typeof raw.appId !== 'string' || raw.appId.length === 0) return null;
    return { v: CREDENTIAL_CONTEXT_VERSION, kind: 'app_bound', appId: asAppId(raw.appId) };
  }
  if (raw.appId !== undefined) return null; // a non-app-bound kind must not carry an appId
  return { v: CREDENTIAL_CONTEXT_VERSION, kind: raw.kind, appId: null };
}

/** The claim a session mints with, for an issuer that has verified the kind (and, for `app_bound`, the owning app id) itself. */
export function buildCredentialContextClaim(kind: CredentialKind, appId?: AppId): CredentialContextClaim {
  if (kind === 'app_bound') {
    if (!appId) throw new Error('app_bound credential context requires an appId');
    return rawCredentialContext(kind, appId);
  }
  return rawCredentialContext(kind);
}
