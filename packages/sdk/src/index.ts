// Self-contained PAS SDK — no runtime dependency on @freeappstore/sdk. The free
// primitives (auth, kv, counters, rooms, proxy, roles) are VENDORED here (copied
// from the FAS SDK source, per the workspace "vendor, don't depend" rule), so a
// published @proappstore/sdk stands alone and never lags a separate package.
import { Auth } from './auth.js';
import { Kv } from './kv.js';
import { Counters } from './counters.js';
import { Rooms } from './rooms.js';
import { Roles } from './roles.js';
import { ApiProxy } from './proxy.js';
import { AI } from './ai.js';
import { Database } from './db.js';
import { Maps } from './maps.js';
import { Notifications } from './notifications.js';
import { SMS } from './sms.js';
import { Storage } from './storage.js';
import { SubscriptionApi } from './subscription.js';
import { LicenseApi } from './license.js';
import { Usage } from './usage.js';
import { Email } from './email.js';
import { Webhooks } from './webhooks.js';
import type { ProInitOptions } from './types.js';

// Vendored base primitive types — one import for app authors.
export type { User, Unsubscribe } from './base-types.js';
export type { AuthProvider } from './auth.js';
export type { ConnectionState, Room, RoomMessage, RoomPeer } from './rooms.js';
export type { DefaultRole, RoleAssignment } from './roles.js';
export { DEFAULT_ROLES } from './roles.js';

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
export { Usage } from './usage.js';
export type { UsageOptions } from './usage.js';
export { Email } from './email.js';
export { Webhooks } from './webhooks.js';
export type { WebhookConfig, WebhookTestResult } from './webhooks.js';

/**
 * Pro SDK instance — the free primitives (auth, kv, counters, rooms, proxy,
 * roles) PLUS the Pro features (db, storage, maps, notifications, sms, ai, usage,
 * email, webhooks, subscription, license). One import, one instance, all features.
 *
 * auth/kv/counters/rooms/roles are FAS-backed (shared identity + free tier);
 * proxy + every Pro feature hit the PAS backend.
 */
export class ProAppStore {
  // Free primitives (FAS-backed)
  readonly auth: Auth;
  readonly kv: Kv;
  readonly counters: Counters;
  readonly rooms: Rooms;
  readonly roles: Roles;
  readonly proxy: ApiProxy;
  // Pro features (PAS-backed)
  readonly subscription: SubscriptionApi;
  readonly license: LicenseApi;
  readonly db: Database;
  readonly storage: Storage;
  readonly maps: Maps;
  readonly notifications: Notifications;
  readonly sms: SMS;
  readonly ai: AI;
  readonly usage: Usage;
  readonly email: Email;
  readonly webhooks: Webhooks;

  constructor(opts: ProInitOptions) {
    const fasApiBase = opts.fasApiBase ?? 'https://api.freeappstore.online';
    const proApiBase = opts.proApiBase ?? 'https://api.proappstore.online';
    // Identity is PAS-owned (its own OAuth + user store); tokens are signed with
    // the shared key so the free-tier primitives (kv/counters/rooms/roles, which
    // run on the free-tier backend) still accept them.
    this.auth = new Auth(opts.appId, proApiBase);
    this.kv = new Kv(opts.appId, fasApiBase, this.auth);
    this.counters = new Counters(opts.appId, fasApiBase, this.auth);
    this.rooms = new Rooms(opts.appId, fasApiBase, this.auth);
    this.roles = new Roles(opts.appId, fasApiBase, this.auth);
    // proxy + Pro features hit the PAS backend (its own proxy/secrets/allowlist).
    this.proxy = new ApiProxy(opts.appId, proApiBase, this.auth);
    this.subscription = new SubscriptionApi(opts.appId, proApiBase, this.auth);
    this.license = new LicenseApi(opts.appId, proApiBase, this.auth);
    this.db = new Database(opts.appId, opts.dataApiBase ?? `https://data-${opts.appId}.proappstore.online`, this.auth);
    this.storage = new Storage(opts.appId, proApiBase, this.auth);
    this.maps = new Maps(proApiBase, this.auth);
    this.notifications = new Notifications(opts.appId, proApiBase, this.auth);
    this.sms = new SMS(opts.appId, proApiBase, this.auth);
    this.ai = new AI(proApiBase, this.auth);
    this.usage = new Usage(opts.appId, proApiBase, this.auth);
    this.email = new Email(opts.appId, proApiBase, this.auth);
    this.webhooks = new Webhooks(opts.appId, proApiBase, this.auth);
    // Auto-start telemetry unless the app opts out. Wrapped in try-catch
    // because localStorage can throw in incognito, sandboxed iframes, or
    // when storage quota is exceeded.
    if (opts.usage?.auto !== false) {
      try { this.usage.start(); } catch { /* non-fatal — app runs without usage tracking */ }
    }
  }
}

/** Create a new ProAppStore SDK instance. Includes all free + pro features. */
export function initPro(opts: ProInitOptions): ProAppStore {
  return new ProAppStore(opts);
}
