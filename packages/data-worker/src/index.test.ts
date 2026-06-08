import { describe, expect, it, vi } from "vitest";
import app from "./index.js";

const TEST_SK = 'test-signing-key';

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

function makeEnv(db = mockD1()) {
  return {
    DB: db as unknown as D1Database,
    APP_ID: "test-app",
    SESSION_SIGNING_KEY: TEST_SK,
  };
}

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
