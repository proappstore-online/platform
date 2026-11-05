# ADR-014: Platform-owned connector consent and independent app grants

**Status:** Accepted for implementation under [#539](https://github.com/proappstore-online/platform/issues/539), part of [#537](https://github.com/proappstore-online/platform/issues/537).

## Context

PAS holds provider credentials for independent apps. Sharing an OAuth client does
not give an app every permission the provider has granted to PAS. Reconnecting
one app must not invalidate another app's access to the same provider identity.
App-controlled copy alone cannot establish the platform's consent boundary.

## Decision

1. Credentials remain encrypted inside the platform. The Google connector keeps
   one shared Google identity per PAS user. A new consent for that same identity
   preserves the shared account epoch and existing provider permissions. An
   unexpected identity change fails without replacing credentials; global
   disconnect is a separate, explicitly explained action.
2. Each app has its own authorization revision and personally approved
   capabilities. Resource grants pin both that revision and the shared account
   epoch. App reconnection invalidates its own grants; app revocation, deletion,
   publisher transfer and contract changes also invalidate pending callbacks.
   Global disconnect invalidates all apps. Refresh persistence uses a separate
   credential revision and cannot overwrite a newer consent's scopes or tokens.
3. New apps declare implemented capabilities and factual purpose, audience,
   retention, privacy and deletion disclosures. The platform owns the consent
   page and verifies the initiating PAS identity, browser, origin and CSRF proof
   before any provider authorization. A GET, app declaration, token scope or
   machine session alone is not personal consent.
4. Personal capability selection, disclosure snapshot, contract hash, version
   and timestamp are stored with the app authorization. Neither a capability
   expansion in another app nor a provider's combined scope set expands this
   authorization. Material declaration changes revoke the app's old consent;
   deployment of an unchanged declaration preserves it. A later rollback cannot
   resurrect a revoked grant.
5. Migration preserves existing authorizations as explicitly legacy access,
   without fabricating current consent receipts or expanding provider scopes.
   Existing pending flows restart through platform consent. Publishers must
   supply factual disclosures before starting fresh consent.

## Limits and follow-ups

Schema validation and personal consent do not prove an app's purpose is allowed
by a provider, nor that its retention/deletion promises work. Operator review,
provider verification, retained-data lifecycle acceptance and user connection
management are separate #537 work. In particular, Google says Meet data should
not be collected for performance tracking or user evaluation. Do not classify an
HR use case as eligible merely because the platform connector exists.

Other providers may use different credential ownership models (for example an
app-owned GitHub installation). Apply the same app isolation and consent
principles without assuming every credential belongs to a personal account.
