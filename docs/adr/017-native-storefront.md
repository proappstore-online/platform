---
description: "The PAS phone companion gains a read-only native storefront: browse the public catalogue, open apps in the browser, no purchase and no web view."
---

# ADR-017: Native storefront in the phone companion (browse only)

## Status

Accepted. Extends ADR-015 and ADR-016; supersedes neither.

## Date

2026-11-23

## Context

ADR-015 describes the companion as a place users visit for account connection, capability consent and occasional settings, and `native-companion-review.md` assessed that product. Users asked for a better way to find PAS apps on the phone. The public catalogue is already published as `https://proappstore.online/catalogue.json`.

## Decision

1. The iOS companion has a native **Storefront** tab (SwiftUI) that lists the public catalogue: featured, categories, search, all apps, and the apps this phone has granted. It is read-only.
2. **No web view and no app container.** Open hands the app's URL to the system browser. ADR-015's rejection of hosting PAS web apps stands.
3. **No purchase and no subscription in the app.** There is no flat platform subscription (decided 2026-11-23), so the storefront shows no Pro status, no price and no Subscribe link.
4. The catalogue and its images are fetched without credentials, from fixed `proappstore.online` and `*.proappstore.online` origins. The `ndev_` device credential is still sent only to `/v1/native/*`.
5. A capability toggle on an app page opens the same platform-reviewed disclosure as the companion's own permission screen. Browsing never creates a grant.
6. Distribution is unchanged: direct developer install only (ADR-016 decision 5).

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Web view of proappstore.online | ADR-016 forbids web views. It adds nothing the browser lacks and weakens the native-functionality case. |
| In-app purchase | Not needed for a developer install, and it would bind PAS billing to Apple's IAP terms before the revenue model is settled. |
| Fetch each app's manifest on device for icons | Duplicates catalogue validation and fails offline. The catalogue publishes `iconUrl`. |

## Consequences

**Positive:**
- Real native utility beyond a permissions panel, which helps a later minimum-functionality review (Apple 4.2).

**Negative:**
- If an app later sells its own subscription, linking to that checkout from the storefront becomes an Apple 3.1.1 (in-app purchase) question at submission. The storefront links only to the apps themselves today.

**Neutral:**
- The Android companion has a matching Store tab under the same rules (#638).
