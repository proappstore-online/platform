import { afterEach, describe, expect, it, vi } from "vitest";
import { getEmbedOrigins, MAX_EMBED_ORIGINS, sanitiseEmbedOrigins } from "./embed-origins.js";

// #453: what the host reads back is written into a response header, so it is checked again here.

function db(first: () => Promise<unknown>) {
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { d1: { prepare } as unknown as D1Database, prepare, bind };
}

afterEach(() => vi.restoreAllMocks());

describe("sanitiseEmbedOrigins", () => {
  it("keeps well-formed https origins, in order", () => {
    expect(sanitiseEmbedOrigins(["https://example.com", "https://*.partner.com", "https://example.com:8443"]))
      .toEqual(["https://example.com", "https://*.partner.com", "https://example.com:8443"]);
  });

  it("drops anything that is not a plain https origin", () => {
    expect(sanitiseEmbedOrigins([
      "http://example.com", "example.com", "https://example.com/path", "https://example.com?x=1", "https://user@example.com",
      "https://example.com;", "https://example.com a", "https://EXAMPLE.com", "https://localhost", "https://*", "https://*.com.",
      "https://a.*.example.com", "https://example.com:999999", "", 5, null, {}, ["https://example.com"],
    ])).toEqual([]);
  });

  it("drops duplicates and caps the list", () => {
    expect(sanitiseEmbedOrigins(["https://a.example.com", "https://a.example.com"])).toEqual(["https://a.example.com"]);
    const many = Array.from({ length: 25 }, (_, i) => `https://s${i}.example.com`);
    expect(sanitiseEmbedOrigins(many)).toHaveLength(MAX_EMBED_ORIGINS);
  });

  it("answers [] for a value that is not an array", () => {
    for (const bad of [undefined, null, "https://example.com", { 0: "https://example.com" }, 7]) expect(sanitiseEmbedOrigins(bad)).toEqual([]);
  });
});

describe("getEmbedOrigins", () => {
  it("reads the app's stored list", async () => {
    const { d1, prepare, bind } = db(async () => ({ origins: '["https://example.com","https://*.partner.com"]' }));
    expect(await getEmbedOrigins(d1, "my-app")).toEqual(["https://example.com", "https://*.partner.com"]);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("FROM app_embed WHERE app_id = ?1"));
    expect(bind).toHaveBeenCalledWith("my-app");
  });

  it("is [] for an app that declares nothing", async () => {
    expect(await getEmbedOrigins(db(async () => null).d1, "my-app")).toEqual([]);
  });

  it("is [] when the row is unreadable, and never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getEmbedOrigins(db(async () => ({ origins: "not json" })).d1, "a")).toEqual([]);
    expect(await getEmbedOrigins(db(async () => ({ origins: 5 })).d1, "a")).toEqual([]);
    expect(await getEmbedOrigins(db(async () => { throw new Error("D1 down"); }).d1, "a")).toEqual([]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("D1 down"));
  });

  it("is quietly [] before the migration has reached this database", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getEmbedOrigins(db(async () => { throw new Error("D1_ERROR: no such table: app_embed"); }).d1, "a")).toEqual([]);
    expect(err).not.toHaveBeenCalled();
  });

  it("drops a bad origin stored in an otherwise good row", async () => {
    const { d1 } = db(async () => ({ origins: '["https://ok.example.com","https://x.com; script-src *"]' }));
    expect(await getEmbedOrigins(d1, "a")).toEqual(["https://ok.example.com"]);
  });
});
