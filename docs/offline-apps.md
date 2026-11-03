---
description: "Build opt-in offline PAS apps with local content, verified downloads and durable job checkpoints."
---

# Offline apps

PAS supports deliberate local content through `@proappstore/sdk/offline`. Existing apps keep their authenticated shell and online data behavior. Opt into `<AppShell access="local">` only for features that can run without server authorization. Authentication still uses the network; local mode does not supply a cached user or permit authenticated server actions.

## Choose the data lifetime

| Data | Store and retention |
| --- | --- |
| Ordinary authenticated query results | In-memory session cache; clear on account changes. |
| Imported text, edits, locally generated audio | SDK local store, explicit device or account scope. |
| Account content deliberately saved for offline use | Account store with a declared access and sign-out policy. |
| Public model files | Download manager with immutable version, byte count and SHA-256. |
| Authentication responses and credentials | Never service-worker/cache copies. |

Device scope is shared by everyone using that browser profile. Account scope separates records and requires a `canAccess` callback checked during operations. It is not encryption. A disconnected device cannot observe a server-side revocation; material requiring fresh authorization must stay online-only. Never infer entitlement from downloaded files or a locally remembered owner ID.

## Local content

```ts
import { createOfflineStore } from '@proappstore/sdk/offline';

const content = createOfflineStore({
  appId: 'reader',
  scope: { kind: 'device' },
});
await content.put({
  id: 'lesson-1',
  value: { text: '你好', position: 0 },
  blob: new Blob(['example audio bytes'], { type: 'audio/wav' }),
});
const metadata = await content.get('lesson-1');
const audio = await content.getBlob('lesson-1');
const page = await content.list({ limit: 25 });
const exported = await content.exportRecord('lesson-1');
await content.delete('lesson-1');
content.close();
```

The metadata and binary payload are separate. Listing records does not load every audio file. Writes resolve after their transaction commits; acknowledge a save only after it resolves. `exportRecord` returns a JSON Blob including the record and its binary payload, suitable for an explicit export/download flow. `clear()` deletes the scope's content, downloads, jobs and queued operations; closing a handle does not delete data. Cancel and await active jobs/downloads/sync before clearing a scope. Clear fails immediately with `OfflineError('busy')` while work holds a shared lock; retry after it settles. Calling clear inside a running handler also fails busy.

For account scope, create a new immutable handle for each owner and supply `canAccess: () => currentOwner === ownerId`. Revoke the old owner and close its handles when identity changes. The callback expresses the app's local access decision; it is not a substitute for server credentials. Do not let a long-running task silently adopt a new user's namespace. Use `bindOfflineAccount(store, app.auth)` when binding an account store to the SDK authentication lifecycle; it closes the handle on an identity change, broadcasts a lock to bound handles for that same namespace in other tabs, and returns a disposer. Bind every account handle, and dispose listeners when done.

Choose sign-out behavior explicitly: purge account content, or retain it locked by the app's local-access policy. Tell users which applies and offer export and deletion, especially for unsynchronized edits. Do not silently discard acknowledged work. Browser settings, private browsing, quota pressure and OS eviction can remove data. `localStorageStatus()` reports available quota estimates/persistence support; requesting persistent storage is a browser decision and is not a backup guarantee. Handle denied storage, quota, closed handles and integrity failures in the UI.

## Public model downloads

```ts
import { createDownloadManager } from '@proappstore/sdk/offline';
const downloads = createDownloadManager(content);
const manifest = {
  id: 'speech-model', version: '1',
  url: 'https://assets.example.org/speech-model-v1.onnx',
  bytes: 123456, sha256: 'a'.repeat(64), // replace with release-pinned values
};
const controller = new AbortController();
const model = await downloads.download(manifest, {
  signal: controller.signal,
  onProgress: ({ loaded, total }) => renderProgress(loaded, total),
});
```

The example hash and size are placeholders, not a usable model. Pin release values, publish a license notice, and show size before downloading. The manager fetches without credentials and refuses authenticated PAS endpoints and redirects. Cross-origin servers must allow CORS and expose `ETag` and `Content-Range` to support range validation. A strong ETag and matching 206 response permit resuming persisted chunks; otherwise a complete 200 response restarts safely. Cancellation keeps checkpointed partial data. Integrity failure deletes the invalid artifact; a partial artifact is never returned as ready. `get(manifest)` verifies stored bytes again; `status` reports partial/ready progress and `remove` deletes an artifact. Set `maxBytes` and `checkpointBytes` through manager options for the app's budget.

SHA-256 verification currently reads the complete artifact into memory. The default maximum is 512 MiB, a guardrail rather than a safe mobile memory budget. Choose substantially smaller model limits based on measured target devices. Public models are reusable device content; private account downloads should use the account store and a separate authorized application flow, never this public-asset fetch path.

## Durable work and optional synchronization

`createLocalJobs(store)` exposes `create({id, kind, input})`, `get`, `list`, `checkpoint`, `setStatus`, `run` and `recover`. Run a worker or other local computation inside `run(id, handler)`; the handler receives `(input, {checkpoint, savedCheckpoint, signal})`. Persist sufficient progress to resume deterministically. `run` records completion/failure, and `recover()` marks abandoned running jobs interrupted after acquiring their lock. Recovery does not restart computation by itself. The app chooses whether to resume, cancel or delete. Browser Web Locks prevent two tabs running the same job; browsers lacking that API cannot safely run these durable operations.

`createSyncQueue(store)` is a narrow explicit queue. Enqueue `{id, kind, payload, idempotent: true}`; call `flush({kind: handler})` only when the app elects to synchronize. A handler receives the payload and stable `operationId`; the server must deduplicate that ID. A crash after the server commits can deliver the same operation again. Failed operations require `retry(id)`. This is at-least-once delivery, not an automatic sync engine or conflict resolver. Keep queues account-bound, make pending/failed state visible, and never replay non-idempotent purchases or destructive actions automatically.

## Shell and updates

Precache only the static shell and runtime assets. Keep `/.pas/*`, authenticated APIs and responses outside all service-worker routes. Download models on demand. Render local data distinctly from current online account state, and show that offline changes are saved locally or pending synchronization.

A service worker that reloads immediately can interrupt active work. For editing/generation/recording, persist a checkpoint and await commit before sending an activation message to a waiting worker. Reload after controller change, then recover the saved work. A prompt is acceptable only when its update button performs this path. Automatic updates remain suitable when no acknowledged work can be lost. The reference fixture demonstrates this protocol with a real waiting worker.

## Executable acceptance and limits

Run `pnpm test:offline-browser` after `pnpm exec playwright install chromium webkit`. The runner bundles actual SDK source into `test/fixtures/offline-reference`, serves it locally and exercises real browser IndexedDB and service workers. Results and 320/390 px screenshots are written to `artifacts/offline-browser/`. Both engines are required; missing browsers fail the command rather than being silently skipped.

The reference verifies a cold browser-process restart offline after shell installation, persisted text/blob/model content, interrupted and corrupt downloads, job checkpoint recovery, account namespace isolation, cross-tab sign-out locking, explicit export/delete/queue behavior and safe service-worker updates. The fixture's worker computes a deterministic checksum; it does not demonstrate Chinese speech quality or usable inference performance. Browser automation is not physical iOS testing. Before shipping a language app, validate model licensing, Mandarin quality, word alignment, real low-memory devices, installed iOS behavior, storage eviction, long-session thermals and accessibility. First-ever launch and first model download require a network connection.

The storage contract is [PAS-DATA-020](standard/data.md#pas-data-020); update/offline rules are [PAS-UI-018](standard/ui.md#pas-ui-018) and [PAS-UI-019](standard/ui.md#pas-ui-019). [ADR-012](adr/012-offline-content.md) records the decision and reuse boundaries. Work and outstanding acceptance are tracked in [#520](https://github.com/proappstore-online/platform/issues/520) and [#524](https://github.com/proappstore-online/platform/issues/524).
