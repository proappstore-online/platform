import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The host trusts the storefront's published catalogue.json to decide which apps
// get host-added discovery (root canonical, sitemap). It must therefore fail
// CLOSED: anything but a clean, well-formed answer means "not in the catalogue".

const URL_ = "https://proappstore.online/catalogue.json";
const good = { id: "meet", name: "Meet", description: "Find people nearby.", appUrl: "https://meet.proappstore.online" };

/** A fresh module per test: the cache and the in-flight request are module state. */
async function load() {
  vi.resetModules();
  return (await import("./public-catalogue.js")).getPublicCatalogueApp;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getPublicCatalogueApp", () => {
  it("returns an approved app by id from the storefront catalogue", async () => {
    fetchMock.mockResolvedValue(json({ apps: [good, { ...good, id: "stash", name: "Stash" }] }));
    const get = await load();
    expect(await get("stash")).toMatchObject({ id: "stash", name: "Stash" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(URL_);
  });

  it("returns undefined for an app that is not in the catalogue", async () => {
    fetchMock.mockResolvedValue(json({ apps: [good] }));
    const get = await load();
    expect(await get("not-listed")).toBeUndefined();
  });

  describe("filtering", () => {
    it("drops entries with a blank or whitespace-only name or description", async () => {
      fetchMock.mockResolvedValue(json({
        apps: [
          good,
          { ...good, id: "no-name", name: "" },
          { ...good, id: "blank-name", name: "   " },
          { ...good, id: "no-desc", description: "" },
          { ...good, id: "blank-desc", description: " \n\t" },
        ],
      }));
      const get = await load();
      expect(await get("meet")).toBeDefined();
      for (const id of ["no-name", "blank-name", "no-desc", "blank-desc"]) expect(await get(id), id).toBeUndefined();
    });

    it("drops entries with a missing or non-string field, and entries that are not objects", async () => {
      fetchMock.mockResolvedValue(json({
        apps: [
          good,
          null,
          "meet",
          42,
          { ...good, id: "no-url", appUrl: undefined },
          { ...good, id: "num-url", appUrl: 5 },
          { ...good, id: "num-name", name: 7 },
          { ...good, id: "num-desc", description: 7 },
          { name: "No id", description: "d", appUrl: "https://x" },
        ],
      }));
      const get = await load();
      expect(await get("meet")).toBeDefined();
      for (const id of ["no-url", "num-url", "num-name", "num-desc"]) expect(await get(id), id).toBeUndefined();
    });
  });

  describe("60 s cache", () => {
    it("serves a second lookup inside the window from the cache, without fetching again", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(json({ apps: [good] }));
      const get = await load();
      expect(await get("meet")).toBeDefined();
      vi.advanceTimersByTime(59_000);
      expect(await get("meet")).toBeDefined();
      expect(await get("other")).toBeUndefined(); // a different id is answered from the same cached list
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("refetches once the window has passed and picks up the new catalogue", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(json({ apps: [good] }))
        .mockResolvedValueOnce(json({ apps: [{ ...good, id: "stash", name: "Stash" }] }));
      const get = await load();
      expect(await get("meet")).toBeDefined();
      vi.advanceTimersByTime(60_001);
      expect(await get("meet")).toBeUndefined();
      expect(await get("stash")).toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("shares one request between lookups made while it is in flight", async () => {
      let release!: (r: Response) => void;
      fetchMock.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
      const get = await load();
      const a = get("meet");
      const b = get("meet");
      release(json({ apps: [good] }));
      expect(await Promise.all([a, b])).toEqual([good, good]);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("does not cache a failure: the next lookup tries again", async () => {
      fetchMock
        .mockResolvedValueOnce(new Response("down", { status: 503 }))
        .mockResolvedValueOnce(json({ apps: [good] }));
      const get = await load();
      expect(await get("meet")).toBeUndefined();
      expect(await get("meet")).toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("fails closed", () => {
    it.each([404, 500, 503])("on a %i response", async (status) => {
      fetchMock.mockResolvedValue(json({ apps: [good] }, status));
      const get = await load();
      expect(await get("meet")).toBeUndefined();
    });

    it.each([
      ["an object without apps", {}],
      ["apps that is not an array", { apps: "meet" }],
      ["apps that is an object", { apps: { meet: good } }],
      ["a bare array", [good]],
      ["null", null],
    ])("on a malformed body: %s", async (_label, body) => {
      fetchMock.mockResolvedValue(json(body));
      const get = await load();
      expect(await get("meet")).toBeUndefined();
    });

    it("on a body that is not JSON", async () => {
      fetchMock.mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
      const get = await load();
      expect(await get("meet")).toBeUndefined();
    });

    it("when the network request throws", async () => {
      fetchMock.mockRejectedValue(new TypeError("network down"));
      const get = await load();
      expect(await get("meet")).toBeUndefined();
    });
  });

  describe("1.5 s timeout", () => {
    it("passes an AbortSignal.timeout(1500) to fetch", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      fetchMock.mockResolvedValue(json({ apps: [good] }));
      const get = await load();
      await get("meet");
      expect(timeout).toHaveBeenCalledWith(1500);
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("answers undefined when the request times out", async () => {
      fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
      const get = await load();
      expect(await get("meet")).toBeUndefined();
    });

    it("answers undefined when the signal aborts a hung request", async () => {
      fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      }));
      const get = await load();
      const started = Date.now();
      expect(await get("meet")).toBeUndefined(); // the real 1.5 s timer fires; nothing is stubbed here
      expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
      expect(Date.now() - started).toBeLessThan(4000);
    }, 8000);
  });
});
