import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_E2E_TEST_PRINCIPAL, E2E_GRANT_REF, E2E_GRANT_WORKFLOW, ensureOidcTestGrant } from "./e2e-grant.js";
import type { Env } from "./env.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type Db = InstanceType<typeof DatabaseSync>;

// #462: provisioning creates the oidc-session grant a new app's e2e job exchanges its
// OIDC token against. The tables are the real ones, built from the real migrations.

const migration = (name: string) => readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");

/** A D1 stand-in over node:sqlite (the subset the step uses). */
function d1(db: Db): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) } }),
      }),
    }),
  } as unknown as D1Database;
}

let db: Db;
const env = (over: Partial<Env> = {}) => ({ DB: d1(db), PUBLISHERS_ORG: "proappstore-online", ...over }) as unknown as Env;

function addPrincipal(slug: string, status = "active") {
  db.prepare("INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES (?, 'test', ?, ?, 1, 1)")
    .run(`test:${slug}`, slug, `test-${slug}`);
  db.prepare("INSERT INTO test_principals (id, slug, user_id, status, created_by, created_at) VALUES (?, ?, ?, ?, 'gh:admin', 1)")
    .run(`tp_${slug}`, slug, `test:${slug}`, status);
}
const grants = () => db.prepare("SELECT * FROM oidc_session_grants ORDER BY created_at").all() as Record<string, unknown>[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, provider TEXT, provider_id TEXT, login TEXT, email TEXT, avatar_url TEXT, created_at INTEGER, last_login_at INTEGER)");
  for (const m of ["0052_oidc_session_grants.sql", "0113_test_principals.sql", "0114_test_principal_lifecycle.sql"]) db.exec(migration(m));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("ensureOidcTestGrant (#462)", () => {
  it("defaults to the e2e-tester account", () => {
    expect(DEFAULT_E2E_TEST_PRINCIPAL).toBe("e2e-tester");
  });

  it("grants <org>/<app> the deploy workflow on main for the e2e-tester principal, with no expiry to lapse silently", async () => {
    addPrincipal("e2e-tester");
    const step = await ensureOidcTestGrant(env(), "my-app");
    expect(step).toMatchObject({ name: "OIDC test login", status: "ok" });
    expect(grants()).toEqual([expect.objectContaining({
      repository: "proappstore-online/my-app",
      workflow: ".github/workflows/deploy.yml",
      ref: "refs/heads/main",
      user_id: "test:e2e-tester",
      principal_id: "tp_e2e-tester",
      scope: "user",
      created_by: "system:provision",
      revoked_at: null,
      expires_at: null,
      mint_count: 0,
    })]);
    expect(E2E_GRANT_WORKFLOW).toBe(".github/workflows/deploy.yml");
    expect(E2E_GRANT_REF).toBe("refs/heads/main");
  });

  it("audits the grant without recording any secret", async () => {
    addPrincipal("e2e-tester");
    await ensureOidcTestGrant(env(), "my-app");
    const [grant] = grants();
    const events = db.prepare("SELECT * FROM test_principal_events").all() as Record<string, unknown>[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ principal_id: "tp_e2e-tester", grant_id: grant!.id, action: "grant.create", actor: "system:provision", request_id: "provision:my-app" });
    expect(JSON.parse(String(events[0]!.detail))).toEqual({ after: { repository: "proappstore-online/my-app", workflow: ".github/workflows/deploy.yml", ref: "refs/heads/main", scope: "user" } });
  });

  it("is idempotent: a second provision makes no second grant and no second audit row", async () => {
    addPrincipal("e2e-tester");
    await ensureOidcTestGrant(env(), "my-app");
    const again = await ensureOidcTestGrant(env(), "my-app");
    expect(again.status).toBe("skip");
    expect(grants()).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM test_principal_events").get() as { n: number }).n).toBe(1);
  });

  it("never replaces a grant someone already made for that repo, workflow and ref", async () => {
    addPrincipal("e2e-tester");
    db.prepare("INSERT INTO oidc_session_grants (id, repository, workflow, ref, user_id, created_by, created_at) VALUES ('manual', 'proappstore-online/my-app', '.github/workflows/deploy.yml', 'refs/heads/main', 'gh:42', 'gh:admin', 1)").run();
    expect((await ensureOidcTestGrant(env(), "my-app")).status).toBe("skip");
    expect(grants()).toEqual([expect.objectContaining({ id: "manual", user_id: "gh:42" })]);
  });

  it("is not blocked by a revoked grant or by a grant for another workflow, repo or ref", async () => {
    addPrincipal("e2e-tester");
    const insert = db.prepare("INSERT INTO oidc_session_grants (id, repository, workflow, ref, user_id, created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, 'gh:42', 'gh:admin', 1, ?)");
    insert.run("revoked", "proappstore-online/my-app", ".github/workflows/deploy.yml", "refs/heads/main", 5);
    insert.run("other-wf", "proappstore-online/my-app", ".github/workflows/e2e-full.yml", "refs/heads/main", null);
    insert.run("other-repo", "proappstore-online/other", ".github/workflows/deploy.yml", "refs/heads/main", null);
    insert.run("other-ref", "proappstore-online/my-app", ".github/workflows/deploy.yml", "refs/heads/next", null);
    expect((await ensureOidcTestGrant(env(), "my-app")).status).toBe("ok");
    expect(grants()).toHaveLength(5);
  });

  describe("fails loudly, with no fallback account and without throwing", () => {
    it("when the e2e-tester account does not exist", async () => {
      // The old canary account exists as a user; it must NOT be used instead.
      db.prepare("INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES ('gh:298595113', 'github', '298595113', 'serge-the-dev', 1, 1)").run();
      const step = await ensureOidcTestGrant(env(), "my-app");
      expect(step.status).toBe("fail");
      expect(step.detail).toContain('test account "e2e-tester" does not exist');
      expect(step.detail).toContain("proappstore-online/my-app");
      expect(step.detail).toContain("no fallback account");
      expect(grants()).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[e2e-grant]"));
    });

    it("when the account is disabled", async () => {
      addPrincipal("e2e-tester", "disabled");
      const step = await ensureOidcTestGrant(env(), "my-app");
      expect(step).toMatchObject({ status: "fail" });
      expect(step.detail).toContain('"e2e-tester" is disabled');
      expect(grants()).toEqual([]);
    });

    it("when the setting is not a valid account slug", async () => {
      for (const bad of ["", "  ", "X", "has space", "../x"]) {
        const step = await ensureOidcTestGrant(env({ E2E_TEST_PRINCIPAL: bad }), "my-app");
        expect(step.status, JSON.stringify(bad)).toBe("fail");
      }
      expect(grants()).toEqual([]);
    });

    it("when the database errors", async () => {
      const broken = { DB: { prepare: () => { throw new Error("D1 down"); } }, PUBLISHERS_ORG: "proappstore-online" } as unknown as Env;
      const step = await ensureOidcTestGrant(broken, "my-app");
      expect(step.status).toBe("fail");
      expect(step.detail).toContain("D1 down");
    });
  });

  it("targets the account named by E2E_TEST_PRINCIPAL when it is set", async () => {
    addPrincipal("e2e-tester");
    addPrincipal("staging-tester");
    await ensureOidcTestGrant(env({ E2E_TEST_PRINCIPAL: "staging-tester" }), "my-app");
    expect(grants()).toEqual([expect.objectContaining({ user_id: "test:staging-tester", principal_id: "tp_staging-tester" })]);
  });

  it("uses the configured organisation", async () => {
    addPrincipal("e2e-tester");
    await ensureOidcTestGrant(env({ PUBLISHERS_ORG: "other-org" }), "my-app");
    expect(grants()).toEqual([expect.objectContaining({ repository: "other-org/my-app" })]);
  });
});
