import { describe, expect, it } from "vitest";
import { AUTH_MODE_META_NAME, AUTH_MODE_META_TAG, MetaTagTracker } from "./meta-rewriter.js";

// #20: the SDK defaults to platform-cookie only when the page carries the
// host's marker, so every HTML page this worker serves must get one.
describe("pas-auth-mode marker", () => {
  const url = "https://meetup.proappstore.online/";

  it("is injected into every page, even with no listing metadata at all", () => {
    const html = new MetaTagTracker({ tagline: null, icon_url: null }, url).missingTagsHtml();
    expect(html).toContain(AUTH_MODE_META_TAG);
    expect(html).toContain('name="pas-auth-mode"');
    expect(html).toContain('content="platform-cookie"');
  });

  it("is injected alongside listing metadata on a custom domain", () => {
    const html = new MetaTagTracker({ title: "Meetup", tagline: "t", icon_url: "/i.png" }, "https://app.example.com/").missingTagsHtml();
    expect(html).toContain(AUTH_MODE_META_TAG);
    expect(html).toContain('<meta property="og:url" content="https://app.example.com/">');
  });

  it("is not duplicated when the app already ships one", () => {
    const tracker = new MetaTagTracker({ tagline: null, icon_url: null }, url);
    tracker.found.add(AUTH_MODE_META_NAME);
    expect(tracker.missingTagsHtml()).not.toContain("pas-auth-mode");
  });
});
