/** Optional local-content APIs. Import from @proappstore/sdk/offline. */
export { createOfflineStore, OfflineStore, OfflineError, bindOfflineAccount, localStorageStatus, OFFLINE_SCHEMA_VERSION } from './offline/store.js';
export type { OfflineStoreOptions, OfflineScope, OfflineErrorCode, LocalRecord, LocalWrite, LocalPage } from './offline/store.js';
export { createDownloadManager, DownloadManager } from './offline/downloads.js';
export type { DownloadManifest, DownloadOptions, DownloadManagerOptions, DownloadStatus, DownloadProgress } from './offline/downloads.js';
export { createLocalJobs, LocalJobs, createSyncQueue, SyncQueue } from './offline/jobs.js';
export type { LocalJob, LocalJobStatus, LocalJobContext, LocalJobHandler, SyncOperation, SyncHandler } from './offline/jobs.js';
