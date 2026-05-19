import { FreeAppStore } from '@freeappstore/sdk';
import { AI } from './ai.js';
import { Database } from './db.js';
import { Maps } from './maps.js';
import { Notifications } from './notifications.js';
import { SMS } from './sms.js';
import { Storage } from './storage.js';
import { SubscriptionApi } from './subscription.js';
import { LicenseApi } from './license.js';
import type { ProInitOptions } from './types.js';

// Re-export everything from FAS SDK so pro apps only need one import
export type {
  User,
  Unsubscribe,
  FasInitOptions,
  ConnectionState,
  Room,
  RoomMessage,
  RoomPeer,
} from '@freeappstore/sdk';

export type {
  ProInitOptions,
  Subscription,
  SubscriptionStatus,
  CheckoutRequest,
  LicenseInfo,
} from './types.js';

export type { QueryResult, ExecuteResult, Migration, MigrateResult } from './db.js';
export type { NotificationPayload, SendResult } from './notifications.js';
export type { SmsSendResult } from './sms.js';
export type {
  TextModelAlias,
  EmbedModelAlias,
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  EmbedOptions,
  EmbedResult,
} from './ai.js';
export { TenantScope } from './tenant.js';

/**
 * Pro SDK instance — includes everything from @freeappstore/sdk (auth, kv,
 * counters, rooms, proxy) plus subscription management and license keys.
 *
 * One import, one instance, all features.
 */
export class ProAppStore extends FreeAppStore {
  readonly subscription: SubscriptionApi;
  readonly license: LicenseApi;
  readonly db: Database;
  readonly storage: Storage;
  readonly maps: Maps;
  readonly notifications: Notifications;
  readonly sms: SMS;
  readonly ai: AI;

  constructor(opts: ProInitOptions) {
    super({ appId: opts.appId, ...(opts.fasApiBase && { apiBase: opts.fasApiBase }) });
    const proApiBase = opts.proApiBase ?? 'https://api.proappstore.online';
    this.subscription = new SubscriptionApi(opts.appId, proApiBase, this.auth);
    this.license = new LicenseApi(opts.appId, proApiBase, this.auth);
    this.db = new Database(opts.appId, opts.dataApiBase ?? `https://data-${opts.appId}.proappstore.online`, this.auth);
    this.storage = new Storage(opts.appId, proApiBase, this.auth);
    this.maps = new Maps(proApiBase);
    this.notifications = new Notifications(opts.appId, proApiBase, this.auth);
    this.sms = new SMS(opts.appId, proApiBase, this.auth);
    this.ai = new AI(proApiBase, this.auth);
  }
}

/** Create a new ProAppStore SDK instance. Includes all free + pro features. */
export function initPro(opts: ProInitOptions): ProAppStore {
  return new ProAppStore(opts);
}
