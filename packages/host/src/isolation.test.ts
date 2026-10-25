import { afterEach, describe, expect, it, vi } from "vitest";
import { applyIsolation, getIsolationMode, isScriptKey } from "./isolation.js";

// #452: cross-origin isolation is opt-in per app; these pin what the host adds, and where.

function db(first: () => Promise<unknown>) {
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { d1: { prepare } as unknown as D1Database, prepare, bind };
}
afterEach(() => vi.restoreAllMocks());

describe("applyIsolation", () => {
  it("adds nothing for an app that did not opt in", () => {
    for (const isHtml of [true, false]) {
      const h = new Headers({ "X-Existing": "1" });
      applyIsolation(h, null, { isHtml });
      const names: string[] = [];
      h.forEach((_value, name) => names.push(name));
      expect(names).toEqual(["x-existing"]);
    }
  });

  it("cross-origin: COOP same-origin and COEP credentialless on a document", () => {
    const h = new Headers();
    applyIsolation(h, "cross-origin", { isHtml: true });
    expect(h.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(h.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
  });

  it("cross-origin-strict: COEP require-corp, for browsers without credentialless (Safari)", () => {
    const h = new Headers();
    applyIsolation(h, "cross-origin-strict", { isHtml: true });
    expect(h.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(h.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
  });

  it("a script gets the embedder policy only, so a Worker can start in an isolated page", () => {
    const h = new Headers();
    applyIsolation(h, "cross-origin", { isHtml: false });
    expect(h.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    expect(h.has("Cross-Origin-Opener-Policy")).toBe(false);
  });

  it("overwrites rather than duplicates a header already set", () => {
    const h = new Headers({ "Cross-Origin-Embedder-Policy": "unsafe-none" });
    applyIsolation(h, "cross-origin-strict", { isHtml: false });
    expect(h.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
  });
});

describe("isScriptKey", () => {
  it.each(["assets/app.js", "worker.mjs", "a/b/c.JS", "sw.js"])("%s is a script", (k) => expect(isScriptKey(k)).toBe(true));
  it.each(["index.html", "style.css", "data.json", "photo.png", "app.js.map", "x.jsx", "mjs", "script.js/other"])("%s is not", (k) => expect(isScriptKey(k)).toBe(false));
});

describe("getIsolationMode", () => {
  it("reads the app's declared mode", async () => {
    for (const mode of ["cross-origin", "cross-origin-strict"]) {
      const { d1, prepare, bind } = db(async () => ({ mode }));
      expect(await getIsolationMode(d1, "my-app")).toBe(mode);
      expect(prepare).toHaveBeenCalledWith(expect.stringContaining("FROM app_isolation WHERE app_id = ?1"));
      expect(bind).toHaveBeenCalledWith("my-app");
    }
  });

  it("is null for an app that declares nothing", async () => {
    expect(await getIsolationMode(db(async () => null).d1, "my-app")).toBeNull();
  });

  it("is null for an unknown or malformed stored value, and never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const row of [{ mode: "same-origin" }, { mode: "" }, { mode: 5 }, {}, "cross-origin"]) expect(await getIsolationMode(db(async () => row).d1, "a"), JSON.stringify(row)).toBeNull();
    expect(await getIsolationMode(db(async () => { throw new Error("D1 down"); }).d1, "a")).toBeNull();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("D1 down"));
  });

  it("is quietly null before the migration has reached this database", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getIsolationMode(db(async () => { throw new Error("D1_ERROR: no such table: app_isolation"); }).d1, "a")).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });
});
