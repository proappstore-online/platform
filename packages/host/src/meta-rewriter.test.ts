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
    const html = new MetaTagTracker(
      { title: "Meetup", tagline: "t", icon_url: "/i.png" },
      "https://app.example.com/",
    ).missingTagsHtml();
    expect(html).toContain(AUTH_MODE_META_TAG);
    expect(html).toContain('<meta property="og:url" content="https://app.example.com/">');
  });

  it("is not duplicated when the app already ships one", () => {
    const tracker = new MetaTagTracker({ tagline: null, icon_url: null }, url);
    tracker.found.add(AUTH_MODE_META_NAME);
    expect(tracker.missingTagsHtml()).not.toContain("pas-auth-mode");
  });
});

it("canonical injection is explicit, private pages are noindex and existing canonicals are preserved", () => {
  const base = {
    tagline: null,
    icon_url: null,
    fallbackTitle: "Public app",
    fallbackDescription: "<Approved> & safe",
  };
  expect(new MetaTagTracker(base, "https://app.example/").missingTagsHtml()).not.toContain(
    'rel="canonical"',
  );
  const publicPage = new MetaTagTracker({ ...base, canonical: true }, "https://app.example/");
  expect(publicPage.missingTagsHtml()).toContain(
    '<link rel="canonical" href="https://app.example/">',
  );
  expect(publicPage.missingTagsHtml()).toContain("&lt;Approved&gt; &amp; safe");
  publicPage.found.add("canonical");
  expect(publicPage.missingTagsHtml()).not.toContain('rel="canonical"');
  const privateHtml = new MetaTagTracker(
    { ...base, canonical: true, private: true },
    "https://app.example/",
  ).missingTagsHtml();
  expect(privateHtml).not.toContain('rel="canonical"');
  expect(privateHtml).toContain('name="robots" content="noindex, nofollow"');
});

it("uses approved fallback descriptions when listing copy is only a repeated placeholder", () => {
  const html = new MetaTagTracker(
    { tagline: "x".repeat(60), icon_url: null, fallbackDescription: "Organize community events." },
    "https://meetup.proappstore.online/",
  ).missingTagsHtml();
  expect(html).toContain('name="description" content="Organize community events."');
  expect(html).toContain('property="og:description" content="Organize community events."');
  expect(html).not.toContain("x".repeat(60));
});
