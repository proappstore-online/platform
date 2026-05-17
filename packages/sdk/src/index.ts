import { FreeAppStore } from '@freeappstore/sdk';
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

/**
 * Pro SDK instance — includes everything from @freeappstore/sdk (auth, kv,
 * counters, rooms, proxy) plus subscription management and license keys.
 *
 * One import, one instance, all features.
 */
export class ProAppStore extends FreeAppStore {
  readonly subscription: SubscriptionApi;
  readonly license: LicenseApi;

  constructor(opts: ProInitOptions) {
    super({ appId: opts.appId, ...(opts.fasApiBase && { apiBase: opts.fasApiBase }) });
    const proApiBase = opts.proApiBase ?? 'https://api.proappstore.online';
    this.subscription = new SubscriptionApi(opts.appId, proApiBase, this.auth);
    this.license = new LicenseApi(opts.appId, proApiBase, this.auth);
  }
}

/** Create a new ProAppStore SDK instance. Includes all free + pro features. */
export function initPro(opts: ProInitOptions): ProAppStore {
  return new ProAppStore(opts);
}
