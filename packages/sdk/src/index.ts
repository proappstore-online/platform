import { SubscriptionApi } from './subscription.js';
import { LicenseApi } from './license.js';
import type { ProInitOptions } from './types.js';

export type {
  ProInitOptions,
  Subscription,
  SubscriptionStatus,
  CheckoutRequest,
  LicenseInfo,
} from './types.js';

export class ProAppStore {
  readonly subscription: SubscriptionApi;
  readonly license: LicenseApi;

  constructor(opts: ProInitOptions) {
    const apiBase = opts.apiBase ?? 'https://api.proappstore.online';
    const tokenFn =
      typeof opts.authToken === 'function' ? opts.authToken : () => opts.authToken as string;
    this.subscription = new SubscriptionApi(opts.appId, apiBase, tokenFn);
    this.license = new LicenseApi(opts.appId, apiBase, tokenFn);
  }
}

export function initPro(opts: ProInitOptions): ProAppStore {
  return new ProAppStore(opts);
}
