import { describe, expect, it, vi } from "vitest";
import { guardProvisionRequest } from "./provision-guard.js";

/**
 * SQL-shape-routed D1 stub. The guard issues three distinct queries (owner
 * lookup, login→id resolution, rate-limit bucket) and a positional mock would
 * make each test depend on their order rather than on what it is asserting.
 */
function db(opts: {
  owner?: { creator_id: string; creator_login: string | null } | null;
  userId?: string | null;
  buckets?: Record<string, { window_start: number; count: number }>;
  failLimiter?: boolean;
} = {}) {
  const buckets = { ...(opts.buckets ?? {}) };
  const sqlSeen: string[] = [];
  const writes: unknown[][] = [];

  const prepare = vi.fn((sql: string) => {
    sqlSeen.push(sql);
    return {
      bind: (...args: unknown[]) => ({
        async first<T>(): Promise<T | null> {
          if (/FROM apps a/i.test(sql)) return (opts.owner ?? null) as T | null;
          if (/FROM users/i.test(sql)) {
            return (opts.userId ? { id: opts.userId } : null) as T | null;
          }
          if (/provision_attempts/i.test(sql)) {
            if (opts.failLimiter) throw new Error("no such table: provision_attempts");
            return (buckets[String(args[0])] ?? null) as T | null;
          }
          return null;
        },
        async run() {
          if (/provision_attempts/i.test(sql) && opts.failLimiter) {
            throw new Error("no such table: provision_attempts");
          }
          writes.push(args);
          return {};
        },
      }),
    };
  });

  return { prepare, sqlSeen, writes };
}

describe("guardProvisionRequest — appId ownership (#83)", () => {
  it("allows an unclaimed appId (first publish)", async () => {
    const r = await guardProvisionRequest({
      db: db({ owner: null }), appId: "brand-new", login: "alice",
    });
    expect(r.ok).toBe(true);
  });

  it("allows the owner to re-publish, matching login case-insensitively", async () => {
    // apps.creator_id is `gh:<numeric id>` while the admin session subject is a
    // GitHub login — the comparison has to go through `users`, not string
    // concatenation, or the real owner is 403'd on every re-publish.
    const r = await guardProvisionRequest({
      db: db({ owner: { creator_id: "gh:2824906", creator_login: "Alice" } }),
      appId: "myapp",
      login: "alice",
    });
    expect(r.ok).toBe(true);
  });

  it("403s when the appId belongs to someone else", async () => {
    const r = await guardProvisionRequest({
      db: db({ owner: { creator_id: "gh:99", creator_login: "victim" } }),
      appId: "victimapp",
      login: "attacker",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/already claimed/i);
  });

  it("fails closed when a claimed app has an unresolvable creator", async () => {
    const r = await guardProvisionRequest({
      db: db({ owner: { creator_id: "gh:ghost", creator_login: null } }),
      appId: "orphaned",
      login: "someone",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/could not be resolved/i);
  });

  it("checks ownership before spending rate budget", async () => {
    // A squatting attempt must not consume the squatter's quota, and the owner
    // should see "not yours" rather than an opaque 429.
    const d = db({ owner: { creator_id: "gh:99", creator_login: "victim" } });
    await guardProvisionRequest({ db: d, appId: "victimapp", login: "attacker" });
    expect(d.sqlSeen.some((s) => /provision_attempts/i.test(s))).toBe(false);
  });
});

describe("guardProvisionRequest — rate limit (#83)", () => {
  const NOW = 1_800_000_000_000;

  it("429s with Retry-After once the hourly cap is spent", async () => {
    const r = await guardProvisionRequest({
      db: db({
        owner: null,
        userId: "gh:1",
        buckets: { "user:gh:1:h": { window_start: NOW, count: 10 } },
      }),
      appId: "another", login: "alice", nowMs: NOW + 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keys on the platform user id so the budget is shared with /v1/provision", async () => {
    const d = db({ owner: null, userId: "gh:2824906" });
    await guardProvisionRequest({ db: d, appId: "x", login: "alice", nowMs: NOW });
    expect(d.writes.some(([key]) => key === "user:gh:2824906:h")).toBe(true);
  });

  it("falls back to a login-scoped budget for an unknown login", async () => {
    const d = db({ owner: null, userId: null });
    await guardProvisionRequest({ db: d, appId: "x", login: "Ghost", nowMs: NOW });
    // The limiter namespaces every identity under `user:`, so the fallback
    // reads as `user:login:<login>` — distinct from a resolved `user:gh:<id>`.
    expect(d.writes.some(([key]) => key === "user:login:ghost:h")).toBe(true);
  });

  it("fails OPEN when the limiter cannot read its table", async () => {
    // The ownership check is the security boundary; this one is an abuse
    // ceiling, and it must not take publishing down on its own.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await guardProvisionRequest({
      db: db({ owner: null, userId: "gh:1", failLimiter: true }),
      appId: "x", login: "alice", nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still enforces ownership when the limiter is broken", async () => {
    const r = await guardProvisionRequest({
      db: db({ owner: { creator_id: "gh:99", creator_login: "victim" }, failLimiter: true }),
      appId: "victimapp", login: "attacker",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });
});
