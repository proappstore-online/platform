/**
 * `@proappstore/sdk/worker` — write an app worker (ADR-009, #254).
 *
 *   // worker/src/app.ts → built to worker/dist/app.js
 *   import { defineAppWorker } from '@proappstore/sdk/worker';
 *   export default defineAppWorker({
 *     async scheduled(event, pas) {
 *       const key = await pas.secrets.get('GITHUB_TOKEN');
 *       await pas.actions.batch(repos.map((r) => ({ name: 'upsert_repo', params: r })));
 *       await pas.log('info', 'synced', { count: repos.length });
 *     },
 *   });
 *
 * The platform's entry shim has verified the event's signature before this
 * module is even imported, so there is no verification here. Delivery is
 * at-least-once: a handler must be idempotent on `event.id`.
 *
 * Zero dependencies; runs inside the worker sandbox.
 */

/** What the platform delivered (ADR-009 §3). */
export interface AppWorkerEvent {
  /** Idempotency key, stable across retries. */
  id: string;
  type: 'schedule' | 'hook' | 'http';
  name?: string;
  attempt: number;
  issuedAt: number;
  payload: unknown;
  /** Hook events (#256): the sender's allowlisted headers and the exact body bytes. */
  hook?: { headers: Record<string, string>; body: Uint8Array };
}

/** A hook envelope's body back to its exact bytes (`utf8` or `base64`, ADR-009 §3). */
export function hookBody(payload: { body?: unknown; body_encoding?: unknown }): Uint8Array {
  const body = typeof payload.body === 'string' ? payload.body : '';
  if (payload.body_encoding !== 'base64') return new TextEncoder().encode(body);
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * The verified-email event a `webhook` handler received, parsed from its body; null when `event`
 * is not one of the `pas.email.*` hooks. The platform has verified and signed it; de-duplicate on `id`.
 */
export function emailEventOf(event: AppWorkerEvent): EmailInboundEvent | EmailDeliveryEvent | null {
  if (event.type !== 'hook' || !event.hook || !event.name?.startsWith('pas.email.')) return null;
  try {
    return JSON.parse(new TextDecoder().decode(event.hook.body)) as EmailInboundEvent | EmailDeliveryEvent;
  } catch {
    return null;
  }
}

export type GoogleCalendarRequest = {
  operation: 'status' | 'start' | 'complete' | 'calendars' | 'grant' | 'disconnect_account' | 'disconnect_app' | 'revoke_grant' | 'grant_status' | 'events' | 'instances' | 'event' | 'conferences' | 'participants' | 'sessions';
  /** Subset of the app's declared capabilities; start opens PAS-owned consent first. */
  capabilities?: ('calendar.read' | 'meet.read')[];
  callback_path?: string;
  return_to?: string;
  state?: string;
  code?: string;
  expected_version?: number;
  /** `disconnect_account` ends Google for every app; send the status result's `authorized_apps` after showing the user that warning. */
  acknowledged_apps?: number;
  calendar_id?: string;
  grant_id?: string;
  event_id?: string;
  page_token?: string;
  starts_at?: number;
  ends_at?: number;
  meeting_code?: string;
  resource?: string;
  receipt?: string;
};

/** `pas.email.send` input (#566). There is no `from`: the sender is the app's registered, approved identity. */
export interface EmailSendInput {
  /** The id or registered address of one of the app's identities (see `pas.email.identities()`). */
  identity: string;
  /** 1-10 recipients. Recipients unrelated to the app need an identity the owner approved for external recipients. */
  to: string | string[];
  /** One line, at most 200 characters. */
  subject: string;
  /** Plain text. Sent as the text part; when `html` is absent it is escaped into the HTML part. */
  text?: string;
  /** The app's own markup for the HTML part. Without `text`, the text part is this with tags stripped. */
  html?: string;
  replyTo?: string;
  /** Required. A retry with the same key and message never sends twice; a different message under it is refused. */
  idempotencyKey: string;
}

/** The platform's record of a send. `accepted` means the provider took it, not that it was delivered. */
export interface EmailSendResult {
  id: string;
  status: 'accepted' | 'refused' | 'unknown';
  providerId: string | null;
  from: string;
  to: string[];
  /** Server time, epoch ms. */
  createdAt: number;
  acceptedAt: number | null;
  errorCode: string | null;
  replayed: boolean;
}

export interface EmailIdentity {
  id: string; address: string; displayName: string | null; replyTo: string | null;
  status: 'pending' | 'approved' | 'revoked'; allowExternal: boolean; suspended: boolean; domainVerified: boolean;
  /** Approved, not suspended, and its domain verified: the only state that can send. */
  usable: boolean;
}

export interface EmailSendRecord extends EmailSendResult {
  subject: string; actor: string; deliveredAt: number | null; bouncedAt: number | null; complainedAt: number | null;
  events: { type: string; at: number; detail: unknown }[];
}

/** The `pas.email.*` hook events (`event.name`) and the JSON in `event.hook.body`. */
export type EmailHookName = 'pas.email.inbound' | 'pas.email.delivered' | 'pas.email.bounced' | 'pas.email.complained';

export interface EmailDeliveryEvent {
  type: 'pas.email.delivered' | 'pas.email.bounced' | 'pas.email.complained';
  /** Stable across retries: de-duplicate on it. */
  id: string;
  sendId: string; providerId: string; from: string; to: string[]; occurredAt: number;
  /** Bounces only. A permanent bounce suppresses the recipient. */
  permanent?: boolean; bounce?: { type: string; subType: string; message: string };
  /** True when the platform added the recipient(s) to the app's suppression list. */
  suppressed: boolean;
}

export interface EmailInboundEvent {
  type: 'pas.email.inbound';
  id: string;
  receivedAt: number;
  identity: { id: string; address: string };
  providerId: string; messageId: string | null;
  from: string; to: string[]; subject: string;
  text: string | null; html: string | null; truncated: boolean;
  headers: Record<string, string>;
  /** The provider's SPF/DKIM/DMARC verdicts (`pass`, `fail`, ...); null when it gave none. Trust these, never the From header. */
  authentication: { spf: string; dkim: string; dmarc: string } | null;
  /** Metadata only; attachment bytes are quarantined and not delivered. */
  attachments: { id: string; filename: string; contentType: string; size: number; quarantined: true }[];
}

export interface PasClient {
  email: {
    /**
     * Send from one of the app's verified identities (#566). Never takes a From, provider id or
     * timestamp. Resolves the send record; rejects, before any provider call, with a stable code
     * after the class: `Forbidden: sender_revoked`, `Forbidden: recipient_suppressed`,
     * `RateLimited: quota_burst`, `Unavailable: email_not_configured`, `BadRequest: idempotency_conflict`, ...
     */
    send(input: EmailSendInput): Promise<EmailSendResult>;
    /** One of this app's send records, with its delivery events. NotFound for any other app's id. */
    get(id: string): Promise<EmailSendRecord>;
    /** The app's sender identities. */
    identities(): Promise<EmailIdentity[]>;
  };
  actions: {
    /** Run a registered action whose `callers` include "worker", as `system:worker`. */
    call(name: string, params?: Record<string, unknown>): Promise<unknown>;
    /** Many invocations in one transaction (≤ 500 statements); counts as one PAS call. */
    batch(calls: { name: string; params?: Record<string, unknown> }[]): Promise<{ name: string; results: unknown[] }[]>;
  };
  secrets: {
    /** An app secret listed in mcp.json `worker.secrets`; null otherwise. */
    get(name: string): Promise<string | null>;
  };
  connectors: {
    /** Platform-held Google Calendar/Meet connection; credentials never enter the app worker. */
    googleCalendar(name: string, request: GoogleCalendarRequest): Promise<Record<string, unknown>>;
    /**
     * A GitHub credential for a connector declared in mcp.json `connectors` (#258): an installation
     * token (repo-scoped when `repo` is given), else the connector's PAT, else null. `mode: 'pat'`
     * forces the PAT — installation tokens cannot answer `viewer` / `@me`; `mode: 'app'` never falls back to it.
     */
    token(name: string, opts?: { repo?: string; mode?: 'app' | 'pat' }): Promise<string | null>;
  };
  storage: {
    /** Stored under the app's worker namespace, never a user's files. ≤ 10 MB. */
    put(key: string, body: string | ArrayBuffer | Uint8Array, opts?: { contentType?: string }): Promise<{ key: string; size: number }>;
    get(key: string): Promise<{ body: ArrayBuffer; contentType: string } | null>;
  };
  rooms: {
    /**
     * Send `data` (JSON, ≤ 4 KB serialized) as a server event to every client
     * connected to `roomId` of this app (#351); browsers receive it through
     * `room.onEvent`. Resolves `{ delivered }`, the number of sockets it reached:
     * 0 when nobody is connected, which is not an error — clients refetch when they
     * reconnect. Rejects with InvalidRoom, PayloadTooLarge, BadRequest (not JSON)
     * or RateLimited (more than 60 publishes a minute for the app). Publishes as
     * `system:worker`. Use `user:<uid>` for one user's events; only that user can
     * join it.
     */
    publish(roomId: string, data: unknown): Promise<{ delivered: number }>;
  };
  apps: {
    /**
     * Run another app's public, read-only action (#599), with exactly the rules an anonymous
     * HTTP caller of `POST /v1/apps/<appId>/actions/<action>` has: same param validation, row
     * and size limits and rate limit (per target app, per calling app). Never runs as
     * `system:worker`, never as a user. Resolves the action's raw answer, `{ rows, meta }`.
     * Rejects with Forbidden for anything but a public query action of a published, non-private
     * app (one answer for unknown, non-public, write, scheduled, staged and private alike),
     * BadRequest (bad names or params), RateLimited, or Failed. One PAS call, recorded as
     * `apps.query` / `<appId>/<action>`.
     */
    query(appId: string, action: string, params?: Record<string, unknown>): Promise<{ rows: unknown[]; meta?: Record<string, unknown> }>;
  };
  /** Append to the app's logs (category `worker`). Resolves false when the app's log quota is spent. */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): Promise<boolean>;
}

export interface AppWorkerHandlers {
  scheduled?(event: AppWorkerEvent, pas: PasClient): Promise<void> | void;
  webhook?(event: AppWorkerEvent, pas: PasClient): Promise<void> | void;
  /**
   * A signed-in user's request to `/.pas/worker/<path>` (#260), as a standard
   * Request. `pas.actions` run AS that user — their rows, their role gates —
   * for the life of the request. Not retried.
   */
  fetch?(request: Request, pas: PasClient): Promise<Response> | Response;
}

/** The module shape the platform shim imports as `app.js`. */
export interface AppWorkerModule {
  fetch(request: Request, env: AppWorkerEnv, ctx: unknown): Promise<Response>;
}

/** The worker's bindings (ADR-009 §2). */
export interface AppWorkerEnv {
  PAS?: PasBinding;
  PAS_WORKER_TOKEN?: string;
  APP_ID?: string;
}

interface CallCtx { token: string; invocation: string; as?: unknown }
interface PasBinding {
  actions: { call(name: string, params: unknown, ctx: CallCtx): Promise<unknown>; batch(calls: unknown, ctx: CallCtx): Promise<unknown> };
  secrets: { get(name: string, ctx: CallCtx): Promise<string | null> };
  connectors: { token(name: string, opts: unknown, ctx: CallCtx): Promise<string | null>; googleCalendar(name: string, request: GoogleCalendarRequest, ctx: CallCtx): Promise<Record<string, unknown>> };
  storage: { put(key: string, body: unknown, opts: unknown, ctx: CallCtx): Promise<unknown>; get(key: string, ctx: CallCtx): Promise<unknown> };
  rooms: { publish(roomId: string, data: unknown, ctx: CallCtx): Promise<unknown> };
  apps: { query(appId: string, action: string, params: unknown, ctx: CallCtx): Promise<unknown> };
  /** `email` is a reserved WorkerEntrypoint handler name, so the platform binding calls it `mail`. */
  mail: { send(input: unknown, ctx: CallCtx): Promise<unknown>; get(id: string, ctx: CallCtx): Promise<unknown>; identities(ctx: CallCtx): Promise<unknown> };
  log(level: string, message: string, fields: unknown, ctx: CallCtx): Promise<boolean>;
}

/**
 * A `PasClient` bound to one invocation: every call carries the worker token and
 * the invocation id. With a caller grant (http events, #260), actions run as that user.
 */
export function pasClient(env: AppWorkerEnv, event: Pick<AppWorkerEvent, 'id' | 'attempt'>, caller?: unknown): PasClient {
  const pas = env.PAS;
  if (!pas) throw new Error('this worker has no PAS binding');
  const ctx: CallCtx = { token: env.PAS_WORKER_TOKEN ?? '', invocation: `${event.id}:${event.attempt}` };
  const actionCtx: CallCtx = caller === undefined ? ctx : { ...ctx, as: caller };
  return {
    actions: {
      call: (name, params) => pas.actions.call(name, params ?? {}, actionCtx),
      batch: (calls) => pas.actions.batch(calls, actionCtx) as Promise<{ name: string; results: unknown[] }[]>,
    },
    secrets: { get: (name) => pas.secrets.get(name, ctx) },
    connectors: {
      token: (name, opts) => pas.connectors.token(name, opts ?? {}, ctx),
      googleCalendar: (name, request) => pas.connectors.googleCalendar(name, request, actionCtx),
    },
    storage: {
      put: (key, body, opts) => pas.storage.put(key, body, opts ?? {}, ctx) as Promise<{ key: string; size: number }>,
      get: (key) => pas.storage.get(key, ctx) as Promise<{ body: ArrayBuffer; contentType: string } | null>,
    },
    rooms: { publish: (roomId, data) => pas.rooms.publish(roomId, data, ctx) as Promise<{ delivered: number }> },
    email: {
      send: (input) => pas.mail.send(input, ctx) as Promise<EmailSendResult>,
      get: (id) => pas.mail.get(id, ctx) as Promise<EmailSendRecord>,
      identities: () => pas.mail.identities(ctx) as Promise<EmailIdentity[]>,
    },
    // ctx, not actionCtx: a caller grant never applies to another app's public action.
    apps: { query: (appId, action, params) => pas.apps.query(appId, action, params ?? {}, ctx) as Promise<{ rows: unknown[]; meta?: Record<string, unknown> }> },
    log: (level, message, fields) => pas.log(level, message, fields, ctx),
  };
}

/**
 * Dispatch the platform's event envelope to `scheduled` (type `schedule`) or
 * `webhook` (type `hook`). A handler that returns is a success (200); one that
 * throws is a failure (500, recorded on the invocation). Browser routes
 * (type `http`) arrive with #260.
 */
export function defineAppWorker(handlers: AppWorkerHandlers): AppWorkerModule {
  return {
    async fetch(request, env) {
      let envelope: { id?: unknown; type?: unknown; name?: unknown; attempt?: unknown; issued_at?: unknown; payload?: unknown };
      try {
        envelope = await request.json();
      } catch {
        return new Response('invalid envelope', { status: 400 });
      }
      const event: AppWorkerEvent = {
        id: String(envelope.id ?? ''),
        type: envelope.type as AppWorkerEvent['type'],
        ...(typeof envelope.name === 'string' ? { name: envelope.name } : {}),
        attempt: Number(envelope.attempt ?? 1),
        issuedAt: Number(envelope.issued_at ?? 0),
        payload: envelope.payload,
      };
      if (event.type === 'hook' && envelope.payload && typeof envelope.payload === 'object') {
        const p = envelope.payload as { headers?: Record<string, string>; body?: unknown; body_encoding?: unknown };
        event.hook = { headers: p.headers ?? {}, body: hookBody(p) };
      }
      if (event.type === 'http') {
        if (!handlers.fetch) return new Response('no handler for http events', { status: 404 });
        const p = (envelope.payload ?? {}) as { method?: string; path?: string; query?: string; headers?: Record<string, string>; body?: unknown; body_encoding?: unknown };
        const method = (p.method ?? 'GET').toUpperCase();
        const url = `https://${env.APP_ID ?? 'app'}.proappstore.online${p.path ?? '/'}${p.query ? `?${p.query}` : ''}`;
        const init: RequestInit = { method, headers: p.headers ?? {} };
        if (method !== 'GET' && method !== 'HEAD') init.body = hookBody(p) as BodyInit;
        return handlers.fetch(new Request(url, init), pasClient(env, event, (envelope as { caller?: unknown }).caller));
      }
      const handler = event.type === 'schedule' ? handlers.scheduled : event.type === 'hook' ? handlers.webhook : undefined;
      if (!handler) return new Response(`no handler for ${String(event.type)} events`, { status: 501 });
      try {
        await handler(event, pasClient(env, event));
        return Response.json({ ok: true });
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
      }
    },
  };
}
