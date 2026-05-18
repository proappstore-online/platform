import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import app from "./index.js";

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

function makeEnv(db = mockD1()) {
  return {
    DB: db as unknown as D1Database,
    APP_ID: "test-app",
    FAS_API_BASE: "https://api.freeappstore.online",
  };
}

// Mock fetch for FAS auth verification
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: "gh:1", login: "testuser" }), { status: 200 })
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await app.request("/health", {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("Auth", () => {
  it("401 without Authorization header", async () => {
    const res = await app.request("/tables", {}, makeEnv());
    expect(res.status).toBe(401);
  });

  it("401 with invalid token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    const res = await app.request("/tables", {
      headers: { Authorization: "Bearer invalid" },
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it("passes with valid token", async () => {
    const res = await app.request("/tables", {
      headers: { Authorization: "Bearer valid-token" },
    }, makeEnv());
    expect(res.status).toBe(200);
  });
});

describe("GET /tables", () => {
  it("lists user tables", async () => {
    const db = mockD1();
    db.prepare = vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({ results: [{ name: "events" }, { name: "rsvps" }], meta: {} }),
    });
    const res = await app.request("/tables", {
      headers: { Authorization: "Bearer tok" },
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
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT * FROM events WHERE city = ?", params: ["SF"] }),
    }, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: unknown[]; meta: { changes: number } };
    expect(body.rows).toEqual([{ id: "1", title: "Test" }]);
  });

  it("rejects empty sql", async () => {
    const res = await app.request("/query", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "" }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it("rejects non-array params", async () => {
    const res = await app.request("/query", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1", params: "not-array" }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });
});

describe("POST /execute", () => {
  it("returns meta with last_row_id", async () => {
    const res = await app.request("/execute", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
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
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
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
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
      body: JSON.stringify({ statements: [] }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });
});
