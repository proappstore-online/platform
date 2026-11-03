---
description: "Opt-in local content, durable work and safe updates without weakening PAS authentication."
---

# ADR-012: Intentional offline content

## Status

Accepted; implementation and acceptance evidence tracked in [#520](https://github.com/proappstore-online/platform/issues/520) and [#524](https://github.com/proappstore-online/platform/issues/524).

## Date

2026-11-03

## Context

PAS treated all persistent browser data as an authenticated response cache. That protects server-derived session state but prevents useful local applications: an imported document, generated audio, and explicitly downloaded public model assets have different lifecycles. Glassdocs already demonstrates browser-local speech processing, while FAS has reusable bundle-size budgets and import-graph checks. Neither establishes PAS account isolation or a general synchronization engine.

## Decision

Keep authenticated AppShell behavior and network-only authentication as the defaults. Apps may explicitly select local access and use the optional `@proappstore/sdk/offline` module. IndexedDB stores separate metadata and blobs, with immutable app/device or app/account namespaces. Account handles require an explicit access callback; identity changes must revoke existing handles. These are application access controls, not encryption or server authorization.

Distinguish four categories:

| Category | Lifetime and authority |
| --- | --- |
| Authenticated action/query cache | Session only; clear on identity change. Server remains authoritative. |
| Locally authored content | Deliberate persistent storage, with visible retention, export and deletion. |
| Deliberately downloaded account content | Explicit account scope and offline-access policy; not a current authorization assertion. |
| Public immutable model assets | Version, byte count and SHA-256 pinned; verify before use, and download on demand. |

Never cache authentication endpoints or fabricate a cached authenticated user. Offline copies cannot learn about remote revocation. Data requiring live authorization remains online-only. Device content belongs to the browser profile, not to a signed-in account.

Use transactional writes and explicit durable checkpoints. Downloads retain bounded chunks and validate HTTP ranges before resuming, then verify the whole artifact. Local jobs use cross-tab locks; abandoned running work becomes interrupted for deliberate recovery. The narrow sync queue accepts explicitly idempotent operations and flushes only when requested. It provides at-least-once delivery, not conflict resolution, automatic replication, or exactly-once execution.

Service-worker updates must preserve acknowledged content and job checkpoints. Apps with active editing, recording or generation checkpoint before activating a waiting worker or show a functional update prompt. Static shell caching never includes authenticated API responses. Model assets do not belong in the initial shell precache.

## Reuse

Borrow Glassdocs' pinned-model/integrity design and FAS' bundle-limit/import-graph ideas with provenance where code is adapted. Keep PAS implementation and tests local; do not couple sibling repositories or introduce a second runtime package manager. Improve lifecycle boundaries, transactional writes, range recovery, cross-tab locking and executable browser evidence in PAS.

## Consequences

Local mode is opt-in and does not change existing authenticated apps. Apps must choose and disclose sign-out behavior: purge, or retain with locally enforced access. They must expose deletion/export and handle quota or eviction without promising permanent storage. A browser profile and same-origin script access remain part of the trust boundary.

The reference fixture tests the actual SDK in Chromium and WebKit, including disconnected navigation, blobs, interrupted work, downloads, account namespaces and a real waiting-worker update. Its deterministic worker does not synthesize speech. Real Chinese model licensing, quality, segmentation, performance, device thermal/memory limits and physical iOS installation/background behavior remain app acceptance work. See the [offline guide](../offline-apps.md).
