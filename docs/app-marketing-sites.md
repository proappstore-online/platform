# App marketing websites — investigation and delivery plan

Status: **implementation in progress**, 2026-10-15. The Astro template builds
a sample artifact, and the shared host has a fail-closed `about-` route backed
by separate storefront-listing and active-revision D1 tables. No production
marketing site is activated yet. Owner content approval, trusted upload,
activation and storefront backfill remain to be implemented. The owner selected
the default URL shape on 2026-10-15.

## Problem and current state

PAS publishes runnable apps at `<id>.proappstore.online`. The separate
`proappstore-online/proappstore` repository builds a catalogue card and a thin
`/apps/<id>/` detail page from `registry.json`. Its `templates/app-detail.html`
contains metadata, a short description, listing details and an **Open app** link;
`detail-page.js` progressively adds owner-edited listing fields from the public
API. This is a store listing, not a dedicated marketing website with a product
story, sections, screenshots and a conversion path.

`publish_app` in `packages/mcp/src/project-tools.ts` calls the admin publish
endpoint. `packages/admin/src/publish.ts` adds a public app to the storefront
registry, and the storefront's `build.js` generates the detail page and sitemap
entry. `packages/backend/src/routes/listings.ts` stores listing copy and assets.
The app's own R2 deployment and the storefront deployment are separate. Some
apps, such as Chess Clubs, hand-build a marketing landing inside their app;
PAS has no common template or publishing lifecycle for that result.

The live check on 2026-10-15 found 23 storefront cards and detail URLs, all
returning 200 with static titles, descriptions, canonicals and Open Graph titles.
The public storefront API returned 40 app records. That difference is **not**
itself proof of a missing marketing website: app provisioning and public
storefront publication are separate decisions. The existing open issue
[`proappstore#3`](https://github.com/proappstore-online/proappstore/issues/3)
tracks stale public/private storefront listings, not marketing-site generation.

## Intended product

PAS should generate and publish a real, branded, one-page **static marketing
website** for a public app from a maintained template and owner-approved copy.
It should work before JavaScript runs and have a clear path to open the app.
The catalogue detail page may link to this website, but it is a separate
surface. Private apps never get a public marketing site.

The first template should include a hero with a specific value proposition,
product imagery, three or more benefits, a short explanation of how the app
works, one or more calls to action, and links to applicable legal/support
documents. It must use the app's own name, colors and assets. It must not invent
pricing, testimonials, customer counts or claims. Missing optional sections
are omitted, not filled with generic claims. An owner can preview the exact
static output before publishing or updating it.

## Why Astro

Astro's default build prerenders pages and endpoints to static HTML. The
marketing template needs no per-request server rendering or client hydration.
One Astro project can render many app sites from validated content records, and
the resulting `dist/` files fit PAS's Cloudflare/R2 hosting model. Astro is a
build-time tool here; the shared PAS host Worker remains the runtime. This
avoids a Worker, Pages project or Astro SSR adapter for each app. The Astro
version should be pinned when implementation begins and reviewed against its
current Node requirement.

Astro references: [static rendering](https://docs.astro.build/en/guides/on-demand-rendering/),
[routing and prerendering](https://docs.astro.build/en/reference/routing-reference/),
[Cloudflare deployment](https://docs.astro.build/en/guides/deploy/cloudflare/).

## Proposed architecture

1. **Content and control.** Keep marketing content distinct from the existing
   listing DTO. Store a validated draft and a published revision per app. Seed
   a draft from listing data, then require an owner review of the headline,
   description, benefits and primary CTA before the first publish. Provide
   owner-only preview and publish controls. Reuse listing assets and moderation
   rules where applicable, but copy approved images into each immutable site
   revision so later listing-asset pruning cannot break a live site. Do not
   treat unreviewed repository text as trusted HTML. A private app is
   ineligible for public publish.
2. **Static build.** Put a reusable Astro marketing template in the storefront
   repository, where the current catalogue build and design live. Build from a
   versioned, validated content snapshot, not a live browser fetch. Render
   semantic HTML, local CSS, images, a canonical, description, Open Graph and
   Twitter metadata, `SoftwareApplication` JSON-LD based on verified fields,
   `robots.txt` and `sitemap.xml`. Prefer zero client JavaScript. Build failure
   must leave the last published revision serving.
3. **Deploy and serve.** Use the existing shared R2/host pattern rather than
   create a Cloudflare project per app. Upload each build to a revisioned R2
   prefix, verify the expected files, then atomically switch the app's active
   revision. The host maps the marketing hostname to the owning app and checks
   current app visibility, explicit storefront publication and active marketing
   revision in D1 **before** serving or using a public cache. `registry.json`
   is currently the storefront listing source; the public API's non-private
   app list also includes apps that were never listed. Add an authoritative D1
   publication flag, update it before unlisting and only after a successful
   listing, and reconcile failures with `registry.json`. Backfill listed status
   from the existing registry before enabling host serving; unknown status
   fails closed. Use a
   narrowly scoped, OIDC-minted upload credential for the trusted storefront
   workflow; do not add standing account keys to app repositories.

   The host's first slice reads `app_storefront_publication.listed` and
   `app_marketing_sites.active_revision` before R2 and serves only
   `marketing/<app-id>/revisions/<revision>/` on the dedicated hostname.
   Both tables start closed; the migration does not mark existing catalogue
   entries as listed or activate any revision. Until the trusted publisher and
   registry reconciliation land, every marketing hostname returns 404.
4. **Lifecycle.** `publish_app` remains the decision to list an app. Marketing
   publish is an explicit second step after preview. A listing edit creates or
   updates a draft and never silently replaces a reviewed live website.
   Republishing is idempotent; a failed build keeps the old site; unlisting or
   making the app private removes public access immediately. The catalogue
   links to the live marketing site only after successful activation.

### Default URL

The first release uses `https://about-<app-id>.proappstore.online/` with a
reserved `about-` hostname prefix. It is a dedicated, crawlable origin while
`https://<app-id>.proappstore.online/` remains the runnable app. Reserve that
prefix for marketing and cap new app IDs at 57 characters: `about-` adds six
characters, and a DNS label cannot exceed 63. Existing BYO app domains should
not silently switch to marketing. A read-only check of the complete production
`apps` registry on 2026-10-15 found 41 IDs, a maximum length of 24 and no
`about-` IDs. The pending submission and provisioning-operation records had no
incompatible IDs either. The first implementation slice adds the new-ID guard
to the CLI, MCP preview, backend and admin creation paths.

Alternatives considered:

| URL | Consequence |
|---|---|
| `proappstore.online/apps/<id>/` | Reuses the current storefront origin but conflates a catalogue entry with the dedicated site the feature is meant to provide. |
| `about-<id>.proappstore.online` | Selected by the owner. Fits the current wildcard host Worker; needs a marketing route and revision lookup. |
| Owner's custom domain | Best branding, but conflicts with domains already serving the interactive app; requires a separate explicit domain attachment workflow. Follow-on work. |

## Acceptance and release evidence

- A public app with approved content gets a distinct one-page site with the
  authored sections, working images and CTA. The raw HTML contains the main
  heading and copy; search crawlers need no JavaScript.
- Title, description, canonical, social image, structured data, robots and
  sitemap use the chosen marketing URL. No hard-coded price or false claims.
- Preview has noindex and cannot be mistaken for a live site. Only the owner
  can publish; a private or unlisted app returns 404 without exposing content.
- A failed build/upload/activation leaves the previous site and canonical URL
  intact. Content edits have a visible draft/published state and deploy receipt.
- Test one new public app, one existing public app and one private app in the
  live environment. Verify GET/HEAD, metadata, sitemap, CTA, image loading,
  cache invalidation, unpublish and rollback after the deploy workflow runs.

## Work split

Track the feature in [platform #397](https://github.com/proappstore-online/platform/issues/397),
with child tickets for [content and publish contract](https://github.com/proappstore-online/platform/issues/398),
[Astro template/build](https://github.com/proappstore-online/proappstore/issues/4),
[R2 deployment and host routing](https://github.com/proappstore-online/platform/issues/399),
and [owner preview and catalogue integration](https://github.com/proappstore-online/console/issues/8).
The URL is decided. A small representative content example is the first
remaining acceptance gate.
Do not close the epic from local tests or a green CI run alone; it requires a
live published site and visibility/rollback evidence.
