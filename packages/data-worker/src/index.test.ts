import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";

const TEST_SK = 'test-signing-key';
const API_BASE = 'https://api.test';

// requireUser authorizes the caller against APP_ID by calling GET {API_BASE}/v1/apps
// over the API service binding. Mock the binding to return the set of app ids the
// caller owns; default authorizes "test-app".
let ownedAppIds: string[] = ['test-app'];
const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
  if (String(input) === `${API_BASE}/v1/apps`) {
    return new Response(JSON.stringify({ apps: ownedAppIds.map((id) => ({ id })) }), { status: 200 });
  }
  return new Response('not found', { status: 404 });
});
afterEach(() => {
  ownedAppIds = ['test-app'];
  apiFetch.mockClear();
});

/** Inline token minting (data-worker has no build-core dep). */
async function mint(uid: string, sk: string): Promise<string> {
  const enc = new TextEncoder();
  const payload = JSON.stringify({
    uid, login: 'testuser', roles: ['user'],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400,
  });
  let bin = '';
  for (const b of enc.encode(payload)) bin += String.fromCharCode(b);
  const body = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const key = await crypto.subtle.importKey('raw', enc.encode(sk), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  let sigBin = '';
  for (const b of new Uint8Array(sig)) sigBin += String.fromCharCode(b);
  const sigB64 = btoa(sigBin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${body}.${sigB64}`;
}

const TOK = await mint('gh:1', TEST_SK);

function mockD1() {
  const rows: Record<string, unknown>[] = [];
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: rows, meta: { changes: 0 } }),
      run: vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 1 } }),
    }),
    batch: vi.fn().mockResolvedValue([
      { results: [], meta: { changes: 1, last_row_id: 1 } },
    ]),
  };
}

const INTERNAL_TOKEN = 'internal-secret';

function makeEnv(db = mockD1(), internalToken?: string) {
  return {
    DB: db as unknown as D1Database,
    APP_ID: "test-app",
    SESSION_SIGNING_KEY: TEST_SK,
    API_BASE,
    ...(internalToken ? { INTERNAL_TOKEN: internalToken } : {}),
    API: { fetch: apiFetch } as unknown as Fetcher,
  };
}

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await app.request("/health", {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("CORS", () => {
  it("allows custom-domain browser preflight requests to /migrate", async () => {
    const res = await app.request("/migrate", {
      method: "OPTIONS",
      headers: {
        Origin: "https://chessclubs.online",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    }, makeEnv());

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://chessclubs.online");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("adds CORS headers to auth failures for custom-domain origins", async () => {
    const res = await app.request("/migrate", {
      method: "POST",
      headers: {
        Origin: "https://chessclubs.online",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ migrations: [{ name: "m1", sql: "CREATE TABLE t (id TEXT)" }] }),
    }, makeEnv());

    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://chessclubs.online");
  });
});

describe("Auth", () => {
  it("401 without Authorization header", async () => {
    const res = await app.request("/tables", {}, makeEnv());
    expect(res.status).toBe(401);
  });

  it("401 with invalid token", async () => {
    const res = await app.request("/tables", {
      headers: { Authorization: "Bearer invalid" },
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it("passes with valid token", async () => {
    const res = await app.request("/tables", {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv());
    expect(res.status).toBe(200);
  });

  it("401s when local verification cannot validate the token", async () => {
    const res = await app.request("/tables", {
      headers: { Authorization: `Bearer ${TOK}` },
    }, { ...makeEnv(), SESSION_SIGNING_KEY: "stale-key" });

    expect(res.status).toBe(401);
  });

  it("403s when the caller does not own this worker's APP_ID (cross-tenant)", async () => {
    ownedAppIds = ["some-other-app"]; // valid session, but not for test-app
    const res = await app.request("/tables", {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv());
    expect(res.status).toBe(403);
  });

  it("does not accept a token signed by a legacy FAS key", async () => {
    const fasToken = await mint("gh:1", "legacy-fas-key");
    const res = await app.request("/tables", {
      headers: { Authorization: `Bearer ${fasToken}` },
    }, {
      ...makeEnv(),
      FAS_SESSION_SIGNING_KEY: "legacy-fas-key",
    } as unknown as ReturnType<typeof makeEnv>);

    expect(res.status).toBe(401);
  });
});

describe("Internal token path (trusted actions-executor)", () => {
  it("allows /query with a valid X-Internal-Token and no bearer, without an ownership check", async () => {
    const db = mockD1();
    db.prepare = vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: [{ id: "1" }], meta: { changes: 0 } }),
      }),
    });
    const res = await app.request("/query", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT * FROM t WHERE user_id = ?", params: ["gh:1"] }),
    }, makeEnv(db, INTERNAL_TOKEN));
    expect(res.status).toBe(200);
    // the trusted path must NOT call the platform ownership endpoint
    expect(apiFetch.mock.calls.some((c) => String(c[0]) === `${API_BASE}/v1/apps`)).toBe(false);
  });

  it("falls through to the session check when X-Internal-Token is wrong (401 without bearer)", async () => {
    const res = await app.request("/query", {
      method: "POST",
      headers: { "X-Internal-Token": "wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    }, makeEnv(mockD1(), INTERNAL_TOKEN));
    expect(res.status).toBe(401);
  });

  it("is inert when INTERNAL_TOKEN is unset (fail-closed — 401 without bearer)", async () => {
    const res = await app.request("/query", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    }, makeEnv()); // no INTERNAL_TOKEN bound
    expect(res.status).toBe(401);
  });

  it("denies an end-user (owns another app) raw /query without the internal token", async () => {
    ownedAppIds = ["some-other-app"]; // valid session, but not this app's owner/dev
    const res = await app.request("/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT * FROM secrets" }),
    }, makeEnv(mockD1(), INTERNAL_TOKEN));
    expect(res.status).toBe(403);
  });

  it("/migrate is allowed via internal token and denied to a non-owner end-user", async () => {
    const ok = await app.request("/migrate", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ migrations: [{ name: "m1", sql: "CREATE TABLE t (id TEXT)" }] }),
    }, makeEnv(mockD1(), INTERNAL_TOKEN));
    expect(ok.status).toBe(200);

    ownedAppIds = ["some-other-app"];
    const denied = await app.request("/migrate", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ migrations: [{ name: "m1", sql: "CREATE TABLE t (id TEXT)" }] }),
    }, makeEnv(mockD1(), INTERNAL_TOKEN));
    expect(denied.status).toBe(403);
  });
});

describe("POST /validate (schema coherence, #33)", () => {
  it("is internal-only — 403 without the internal token", async () => {
    const res = await app.request("/validate", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ statements: [{ id: "t#0", sql: "SELECT 1", paramCount: 0 }] }),
    }, makeEnv(mockD1(), INTERNAL_TOKEN));
    expect(res.status).toBe(403);
  });

  it("EXPLAINs each statement (no execution) and reports per-statement ok/error", async () => {
    const db = mockD1();
    // Compile succeeds unless the statement names the missing column 'nope'.
    db.prepare = vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockImplementation(async () => {
        if (sql.includes("nope")) throw new Error("no such column: nope");
        return { results: [], meta: {} };
      }),
    }));
    const res = await app.request("/validate", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        statements: [
          { id: "good#0", sql: "SELECT * FROM items WHERE id = ?", paramCount: 1 },
          { id: "bad#0", sql: "SELECT nope FROM items", paramCount: 0 },
        ],
      }),
    }, makeEnv(db, INTERNAL_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { id: "good#0", ok: true },
        { id: "bad#0", ok: false, error: "no such column: nope" },
      ],
    });
    // every compile went through EXPLAIN — the raw statement is never executed
    expect(
      (db.prepare as unknown as ReturnType<typeof vi.fn>).mock.calls.every((c) => String(c[0]).startsWith("EXPLAIN ")),
    ).toBe(true);
  });
});

describe("POST /migrate failure isolation (#35)", () => {
  it("reports the exact failed statement and does not mark that migration applied", async () => {
    const runCalls: string[] = [];
    const insertedMigrations: string[] = [];
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        const stmt = {
          bind: vi.fn((...args: unknown[]) => ({
            run: vi.fn(async () => {
              runCalls.push(sql);
              if (sql.includes("INSERT INTO _migrations")) insertedMigrations.push(String(args[0]));
              return { meta: { changes: 1, last_row_id: 1 } };
            }),
          })),
          all: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
          run: vi.fn(async () => {
            runCalls.push(sql);
            if (sql.includes("BROKEN")) throw new Error("no such table: missing_parent");
            return { meta: { changes: 1, last_row_id: 1 } };
          }),
        };
        return stmt;
      }),
      batch: vi.fn(),
    };

    const res = await app.request("/migrate", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        migrations: [
          { name: "0001_init", sql: "CREATE TABLE ok (id TEXT)" },
          { name: "0002_partial", sql: "CREATE TABLE before_failure (id TEXT); BROKEN STATEMENT; CREATE TABLE after_failure (id TEXT)" },
        ],
      }),
    }, makeEnv(db as unknown as ReturnType<typeof mockD1>, INTERNAL_TOKEN));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "migration statement failed",
      migration: "0002_partial",
      statementIndex: 1,
      statement: "BROKEN STATEMENT",
      detail: "no such table: missing_parent",
      applied: ["0001_init"],
      already: [],
    });
    expect(insertedMigrations).toEqual(["0001_init"]);
    expect(runCalls).toContain("CREATE TABLE before_failure (id TEXT)");
    expect(runCalls).not.toContain("CREATE TABLE after_failure (id TEXT)");
  });

  it("does not report success when _migrations cannot record an applied migration", async () => {
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn((...args: unknown[]) => ({
          run: vi.fn(async () => {
            if (sql.includes("INSERT INTO _migrations")) throw new Error(`constraint failed for ${String(args[0])}`);
            return { meta: { changes: 1, last_row_id: 1 } };
          }),
        })),
        all: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
        run: vi.fn(async () => ({ meta: { changes: 1, last_row_id: 1 } })),
      })),
      batch: vi.fn(),
    };

    const res = await app.request("/migrate", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ migrations: [{ name: "0001_init", sql: "CREATE TABLE ok (id TEXT)" }] }),
    }, makeEnv(db as unknown as ReturnType<typeof mockD1>, INTERNAL_TOKEN));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "migration tracking insert failed",
      migration: "0001_init",
      detail: "constraint failed for 0001_init",
      applied: [],
      already: [],
    });
  });
});

describe("GET /tables", () => {
  it("lists user tables", async () => {
    const db = mockD1();
    db.prepare = vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({ results: [{ name: "events" }, { name: "rsvps" }], meta: {} }),
    });
    const res = await app.request("/tables", {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["events", "rsvps"]);
  });
});

describe("POST /query", () => {
  it("returns rows", async () => {
    const db = mockD1();
    db.prepare = vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: [{ id: "1", title: "Test" }], meta: { changes: 0 } }),
      }),
    });
    const res = await app.request("/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT * FROM events WHERE city = ?", params: ["SF"] }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: unknown[]; meta: { changes: number } };
    expect(body.rows).toEqual([{ id: "1", title: "Test" }]);
  });

  it("rejects empty sql", async () => {
    const res = await app.request("/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "" }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it("rejects non-array params", async () => {
    const res = await app.request("/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1", params: "not-array" }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });
});

describe("POST /execute", () => {
  it("returns meta with last_row_id", async () => {
    const res = await app.request("/execute", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "INSERT INTO events VALUES (?)", params: ["test"] }),
    }, makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { meta: { last_row_id: number } };
    expect(body.meta.last_row_id).toBe(1);
  });
});

describe("POST /batch", () => {
  it("runs multiple statements", async () => {
    const res = await app.request("/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        statements: [
          { sql: "INSERT INTO events VALUES (?)", params: ["a"] },
        ],
      }),
    }, makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    expect(body.results).toHaveLength(1);
  });

  it("rejects empty statements array", async () => {
    const res = await app.request("/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ statements: [] }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });
});
