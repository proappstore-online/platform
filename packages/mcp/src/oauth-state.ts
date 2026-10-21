import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import {
  brokerMcpReadSeen, handleOAuthRoute, issueBrokerCredential, listGrants,
  recordBrokerMcpRead, resolveOAuthToken, revokeGrant, type OAuthConfig,
} from "./oauth-provider.js";

const LEGACY_TTL = 90 * 86_400;

/** Strongly consistent OAuth state. KV remains a read-only migration source and
 * the audit store. Tombstones prevent an old KV value from resurrecting a code,
 * refresh token or revoked grant during migration. */
export class OAuthState extends DurableObject<Env> {
  private readonly legacyUntil: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS oauth_entries (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER NOT NULL, purge_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth_entries(expires_at)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS oauth_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO oauth_meta VALUES ('legacy_until', ?)", Date.now() + LEGACY_TTL * 1000);
    this.legacyUntil = ctx.storage.sql.exec<{ value: number }>("SELECT value FROM oauth_meta WHERE key = 'legacy_until'").one().value;
  }

  private now() { return Date.now(); }

  private async get(key: string): Promise<string | null> {
    const row = this.ctx.storage.sql.exec<{ value: string | null; expires_at: number }>("SELECT value, expires_at FROM oauth_entries WHERE key = ?", key).toArray()[0];
    if (row) return row.expires_at > this.now() ? row.value : null;
    // Never copy a legacy read: doing so would extend an unknown remaining TTL.
    return this.now() < this.legacyUntil ? await this.env.OAUTH_KV?.get(key) ?? null : null;
  }

  private async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    const expires = options?.expiration !== undefined ? options.expiration * 1000
      : this.now() + (options?.expirationTtl ?? LEGACY_TTL) * 1000;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO oauth_entries VALUES (?, ?, ?, ?)", key, value, expires, Math.max(expires, this.legacyUntil));
    await this.scheduleCleanup();
  }

  private async remove(key: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO oauth_entries VALUES (?, NULL, ?, ?)", key, this.now(), Math.max(this.now(), this.legacyUntil));
    await this.scheduleCleanup();
  }

  private async list(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult<unknown>> {
    const prefix = options?.prefix ?? "";
    const names = new Set<string>();
    if (this.now() < this.legacyUntil && this.env.OAUTH_KV) {
      let cursor: string | undefined;
      do {
        const page = await this.env.OAUTH_KV.list({ prefix, ...(cursor ? { cursor } : {}) });
        for (const key of page.keys) names.add(key.name);
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
    const rows = this.ctx.storage.sql.exec<{ key: string; value: string | null; expires_at: number }>(
      "SELECT key, value, expires_at FROM oauth_entries WHERE key >= ? AND key < ? ORDER BY key", prefix, `${prefix}\uffff`,
    );
    for (const row of rows) {
      if (row.value !== null && row.expires_at > this.now()) names.add(row.key);
      else names.delete(row.key);
    }
    const offset = Math.max(0, Number(options?.cursor) || 0);
    const limit = Math.max(1, Math.min(1000, options?.limit ?? 1000));
    const ordered = [...names].sort();
    const keys = ordered.slice(offset, offset + limit).map((name) => ({ name }));
    return offset + limit >= ordered.length
      ? { keys, list_complete: true, cacheStatus: null }
      : { keys, list_complete: false, cursor: String(offset + limit), cacheStatus: null };
  }

  private store(): KVNamespace {
    // OAuth only uses the string/TTL subset of KV. The authority owns and
    // serializes every operation involving multiple keys; no caller gets this adapter.
    return {
      get: (key: string) => this.get(key),
      put: (key: string, value: string, options?: KVNamespacePutOptions) => this.put(key, value, options),
      delete: (key: string) => this.remove(key),
      list: (options?: KVNamespaceListOptions) => this.list(options),
    } as unknown as KVNamespace;
  }

  private config(issuer: string): OAuthConfig {
    const ttl = Number(this.env.OAUTH_REFRESH_TTL_SECONDS);
    return {
      issuer, kv: this.store(), sessionSigningKey: this.env.SESSION_SIGNING_KEY!,
      authStart: this.env.AUTH_START ?? `${this.env.API_BASE}/v1/auth/github/start`, api: this.env.API,
      authProviders: this.env.AUTH_PROVIDERS?.split(",").map((s) => s.trim()).filter((s): s is "github" | "google" => s === "github" || s === "google"),
      clientMetadataHosts: this.env.OAUTH_CIMD_HOSTS?.split(",").map((s) => s.trim()).filter(Boolean),
      ...(Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= LEGACY_TTL ? { refreshTokenTtlSeconds: ttl } : {}),
    };
  }

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () =>
      await handleOAuthRoute(request, this.config(new URL(request.url).origin)) ?? new Response("Not found", { status: 404 }),
    );
  }

  async resolveToken(token: string) {
    return this.ctx.blockConcurrencyWhile(() => resolveOAuthToken(token, this.store()));
  }

  async issueBroker(issuer: string, input: { session: string; ownerId: string; resource: string; requestId: string }) {
    return this.ctx.blockConcurrencyWhile(() => issueBrokerCredential(this.config(issuer), input));
  }

  async grants(uid: string, appId: string | null) {
    return this.ctx.blockConcurrencyWhile(() => listGrants(this.store(), uid, appId));
  }

  async revoke(uid: string, id: string) {
    return this.ctx.blockConcurrencyWhile(() => revokeGrant(this.config("https://mcp.proappstore.online"), uid, id));
  }

  async recordRead(id: string) {
    return this.ctx.blockConcurrencyWhile(() => recordBrokerMcpRead(this.store(), id));
  }

  async readSeen(id: string) {
    return this.ctx.blockConcurrencyWhile(() => brokerMcpReadSeen(this.store(), id));
  }

  private async scheduleCleanup() {
    const next = this.now() + 3_600_000;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    const now = this.now();
    this.ctx.storage.sql.exec("UPDATE oauth_entries SET value = NULL WHERE expires_at <= ? AND value IS NOT NULL", now);
    this.ctx.storage.sql.exec("DELETE FROM oauth_entries WHERE purge_at <= ?", now);
    if (this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_entries").one().n) await this.scheduleCleanup();
  }
}
