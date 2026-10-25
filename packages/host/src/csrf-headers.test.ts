import { describe, expect, it } from "vitest";
import { isSameOriginMutation } from "./auth-handler.js";
import { securityHeaders } from "./host.js";

const req = (headers: Record<string, string>) =>
  new Request("https://meetup.proappstore.online/.pas/api/v1/apps/meetup/kv/x", { method: "PUT", headers });

describe("isSameOriginMutation (F1 — fail closed)", () => {
  it("accepts an explicit same-origin Origin", () => {
    expect(isSameOriginMutation(req({ Origin: "https://meetup.proappstore.online" }))).toBe(true);
  });
  it("accepts Sec-Fetch-Site: same-origin when Origin is absent", () => {
    expect(isSameOriginMutation(req({ "Sec-Fetch-Site": "same-origin" }))).toBe(true);
  });
  it("rejects a cross-origin Origin", () => {
    expect(isSameOriginMutation(req({ Origin: "https://evil.example" }))).toBe(false);
  });
  it("rejects when NEITHER Origin nor Sec-Fetch-Site is present (was fail-open)", () => {
    expect(isSameOriginMutation(req({}))).toBe(false);
  });
  it("rejects Sec-Fetch-Site: none (top-level nav, not an app fetch)", () => {
    expect(isSameOriginMutation(req({ "Sec-Fetch-Site": "none" }))).toBe(false);
  });
});

describe("securityHeaders frame-ancestors (F3 — no cross-app framing)", () => {
  it("does not allow the *.proappstore.online wildcard to frame apps", () => {
    const csp = securityHeaders(true).get("Content-Security-Policy") ?? "";
    const fa = csp.split(";").find((d) => d.trim().startsWith("frame-ancestors")) ?? "";
    expect(fa).not.toContain("*.proappstore.online");
    expect(fa).toContain("'self'");
  });
});

describe("securityHeaders frame-ancestors opt-in embedding (#453)", () => {
  const frameAncestors = (embed?: readonly string[]) =>
    (securityHeaders(true, false, embed).get("Content-Security-Policy") ?? "").split("; ").find((d) => d.startsWith("frame-ancestors")) ?? "";
  const DEFAULT = "frame-ancestors 'self' https://proappstore.online https://console.proappstore.online https://dashboard.proappstore.online https://admin.proappstore.online https://agents.proappstore.online";

  it("is byte-for-byte the default when the app names no origins", () => {
    expect(frameAncestors()).toBe(DEFAULT);
    expect(frameAncestors([])).toBe(DEFAULT);
  });

  it("appends exactly the named origins after the defaults", () => {
    expect(frameAncestors(["https://example.com", "https://*.partner.com"])).toBe(`${DEFAULT} https://example.com https://*.partner.com`);
  });

  it("never lets a bad value reach the header, whatever the stored row says", () => {
    const fa = frameAncestors([
      "https://ok.example.com",
      "http://plain.example.com",
      "https://example.com; script-src *",
      "https://example.com\nX-Injected: 1",
      "https://a.com https://b.com",
      "*",
      "https://*",
      "https://*.*.example.com",
    ]);
    expect(fa).toBe(`${DEFAULT} https://ok.example.com`);
  });

  it("leaves every other directive and the other headers alone", () => {
    const plain = securityHeaders(true);
    const embedded = securityHeaders(true, false, ["https://example.com"]);
    const rest = (h: Headers) => (h.get("Content-Security-Policy") ?? "").split("; ").filter((d) => !d.startsWith("frame-ancestors"));
    expect(rest(embedded)).toEqual(rest(plain));
    expect(embedded.get("X-Frame-Options")).toBe("SAMEORIGIN"); // old browsers without frame-ancestors still refuse
    expect(embedded.get("Permissions-Policy")).toBe(plain.get("Permissions-Policy"));
    expect(embedded.get("Cache-Control")).toBe(plain.get("Cache-Control"));
  });
});
