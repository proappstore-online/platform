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
