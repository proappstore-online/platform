import { describe, expect, it } from "vitest";
import { isBlockedAssetPath } from "./host.js";

/**
 * Source maps must never be served from an app's R2 prefix. PAS allows
 * proprietary source on Pro, and the serving path maps any request 1:1 onto the
 * app's prefix — so without this, one `build.sourcemap: true` publishes an app's
 * original source.
 */
describe("isBlockedAssetPath", () => {
  it("blocks source maps for js, css, and hashed bundles", () => {
    expect(isBlockedAssetPath("/assets/index-abc123.js.map")).toBe(true);
    expect(isBlockedAssetPath("/assets/index.css.map")).toBe(true);
    expect(isBlockedAssetPath("/bundle.mjs.map")).toBe(true);
    expect(isBlockedAssetPath("/deep/nested/path/chunk.js.map")).toBe(true);
  });

  it("blocks regardless of case, since R2 keys and URLs are case-sensitive but authors are not", () => {
    expect(isBlockedAssetPath("/assets/index.js.MAP")).toBe(true);
    expect(isBlockedAssetPath("/assets/index.js.Map")).toBe(true);
  });

  it("ignores a query string rather than being bypassed by one", () => {
    expect(isBlockedAssetPath("/assets/index.js.map?v=2")).toBe(true);
    expect(isBlockedAssetPath("/assets/index.js.map?")).toBe(true);
  });

  it("serves everything else untouched", () => {
    expect(isBlockedAssetPath("/")).toBe(false);
    expect(isBlockedAssetPath("/index.html")).toBe(false);
    expect(isBlockedAssetPath("/assets/index-abc123.js")).toBe(false);
    expect(isBlockedAssetPath("/assets/style.css")).toBe(false);
    expect(isBlockedAssetPath("/icon-192.png")).toBe(false);
    expect(isBlockedAssetPath("/manifest.webmanifest")).toBe(false);
    expect(isBlockedAssetPath("/.well-known/assetlinks.json")).toBe(false);
  });

  it("does not block a route that merely contains 'map'", () => {
    // A mapping app's own routes must keep working — the check is an extension,
    // not a substring.
    expect(isBlockedAssetPath("/map")).toBe(false);
    expect(isBlockedAssetPath("/maps/london")).toBe(false);
    expect(isBlockedAssetPath("/sitemap.xml")).toBe(false);
    expect(isBlockedAssetPath("/roadmap")).toBe(false);
    expect(isBlockedAssetPath("/assets/map.js")).toBe(false);
  });
});
