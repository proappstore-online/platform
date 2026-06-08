// Self-contained PAS SDK. All primitives (auth, kv, counters, rooms, roles,
// proxy, db, etc.) hit the PAS backend — no FAS dependency at runtime.
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
import { Invites } from './invites.js';
import type { ProInitOptions } from './types.js';

// Vendored base primitive types — one import for app authors.
export type { User, Unsubscribe } from './base-types.js';
export type { AuthProvider } from './auth.js';
export type { ConnectionState, Room, RoomMessage, RoomPeer } from './rooms.js';
export type { DefaultRole, RoleAssignment } from './roles.js';
export { DEFAULT_ROLES } from './roles.js';
export type { Invite, InviteListItem, CreateInviteOptions, RedeemResult } from './invites.js';

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
 * Pro SDK instance — all features hit the PAS backend.
 */
export class ProAppStore {
  readonly auth: Auth;
  readonly kv: Kv;
  readonly counters: Counters;
  readonly rooms: Rooms;
  readonly roles: Roles;
  readonly proxy: ApiProxy;
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
  readonly invites: Invites;

  constructor(opts: ProInitOptions) {
    const apiBase = opts.proApiBase ?? 'https://api.proappstore.online';
    this.auth = new Auth(opts.appId, apiBase);
    this.kv = new Kv(opts.appId, apiBase, this.auth);
    this.counters = new Counters(opts.appId, apiBase, this.auth);
    this.rooms = new Rooms(opts.appId, apiBase, this.auth);
    this.roles = new Roles(opts.appId, apiBase, this.auth);
    this.proxy = new ApiProxy(opts.appId, apiBase, this.auth);
    this.subscription = new SubscriptionApi(opts.appId, apiBase, this.auth);
    this.license = new LicenseApi(opts.appId, apiBase, this.auth);
    this.db = new Database(opts.appId, opts.dataApiBase ?? `https://data-${opts.appId}.proappstore.online`, this.auth);
    this.storage = new Storage(opts.appId, apiBase, this.auth);
    this.maps = new Maps(apiBase, this.auth);
    this.notifications = new Notifications(opts.appId, apiBase, this.auth);
    this.sms = new SMS(opts.appId, apiBase, this.auth);
    this.ai = new AI(apiBase, this.auth);
    this.usage = new Usage(opts.appId, apiBase, this.auth);
    this.email = new Email(opts.appId, apiBase, this.auth);
    this.webhooks = new Webhooks(opts.appId, apiBase, this.auth);
    this.invites = new Invites(opts.appId, apiBase, this.auth);
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
