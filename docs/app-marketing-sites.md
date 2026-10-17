# App marketing websites

Status: **design changed 2026-10-18** (#409, split from #398). Every app gets a
public marketing site at `https://about-<app-id>.proappstore.online/`, private
apps included. The site is an ordinary static build that lives in the app's own
repository and ships with the app's normal deploy. The platform stores no
marketing content, has no console UI for it and exposes no build-snapshot
endpoint. The shared host serves an app's site whenever it has an active
revision. No production marketing site is activated yet.

## Problem

PAS publishes runnable apps at `<id>.proappstore.online`. The separate
`proappstore-online/proappstore` repository builds a catalogue card and a thin
`/apps/<id>/` detail page from `registry.json`: a store listing, not a
dedicated marketing website with a product story, screenshots and a path to
open the app. Some apps, such as Chess Clubs, hand-build a marketing landing
inside their app; PAS had no common way to publish one beside the app.

## The model

1. **Every app, every visibility.** A marketing site is public by nature: it
   describes the app, it does not run it. A private app's site is public while
   the app itself stays private: `about-<id>` and `<id>` are separate origins,
   and the host's private-app gate still guards the app origin. Neither the
   app's visibility nor its storefront listing (`registry.json`,
   `app_storefront_publication`) gates the marketing site.
2. **Template in the app repository.** The site's source — copy, images, theme
   — is a static template committed in the app repo, edited like any other
   file in it. What the owner commits is what is published; there is no
   separate draft, review or approval step in the platform.
3. **Built by the normal deploy.** The app's deploy workflow builds the
   template alongside the app and uploads the result as an immutable revision.
   There is no separate marketing pipeline and no build-snapshot endpoint.
4. **No platform-stored content, no console UI.** The platform holds only the
   built artifact (in R2), its deploy receipt and which revision is active.
5. **Static, honest output.** Semantic HTML that works before JavaScript runs,
   local CSS and images, canonical, description, Open Graph/Twitter metadata,
   `robots.txt` and `sitemap.xml`, zero client JavaScript. The template must
   not invent pricing, testimonials, customer counts or claims; absent optional
   sections are omitted.

Astro fits the build: it prerenders static HTML, needs no SSR adapter, and its
`dist/` output fits the shared R2/host model, so no Worker or Pages project is
created per app. The storefront repo's `marketing/` builder (proappstore#4)
is the reference implementation of the template and its
`artifact-manifest.json`.

## Default URL

`https://about-<app-id>.proappstore.online/` with a reserved `about-` hostname
prefix: a dedicated, crawlable origin, while `https://<app-id>.proappstore.online/`
remains the runnable app. New app IDs are capped at 57 characters (`about-`
adds six; a DNS label cannot exceed 63) and may not start with `about-` — the
guard is in the CLI, MCP, backend and admin creation paths. A read-only check
of the production `apps` registry on 2026-10-15 found 41 IDs, a maximum length
of 24 and no `about-` IDs. Existing BYO app domains do not switch to marketing.

| URL | Consequence |
|---|---|
| `proappstore.online/apps/<id>/` | Conflates the catalogue entry with the dedicated site. |
| `about-<id>.proappstore.online` | Selected by the owner. Fits the wildcard host Worker. |
| Owner's custom domain | Conflicts with domains serving the app; follow-on work. |

## Serving (`packages/host/src/marketing-site.ts`)

- The host maps `about-<id>` to app `<id>` and reads only
  `app_marketing_sites.active_revision` for it (an `apps` row must exist). With
  an active revision it serves `marketing/<id>/revisions/<revision>/` from the
  `pas-apps` bucket; without one, 404. A missing table is a 404, any other D1
  error a 503, an R2 failure an uncached 503.
- Paths: `/`, `/index.html`, `/robots.txt`, `/sitemap.xml`, `/_astro/*` and
  `/assets/*`. Everything else — unknown paths, dotfiles, `..`, source maps,
  the artifact manifest — is a real 404, never the app's SPA fallback. R2 keys
  are built from the hostname's own app id only.
- GET and HEAD, with accurate content types and ETag/304. Nothing is
  edge-cached: every response is `public, max-age=0, must-revalidate`, so a
  revision switch or an unpublish is seen on the next request. Responses carry
  a static-site CSP (`default-src 'none'`, `script-src 'self'`,
  `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, HSTS and the
  serving revision in `X-PAS-Marketing-Revision`.

## Upload, activation and rollback (`packages/backend/src/routes/marketing-deploy.ts`)

| Route | Effect |
|---|---|
| `PUT /v1/apps/:id/marketing/revisions/:revision` | multipart: `manifest` (the build's `artifact-manifest.json`) plus one part per listed path. Every file must match its size and SHA-256 and be a path the host serves; the files, then the manifest, go to `marketing/<id>/revisions/<revision>/`. Never activates. A revision is immutable: the same bytes again are a no-op, other bytes a 409. |
| `POST /v1/apps/:id/marketing/activate` `{revision}` | re-reads and re-hashes the stored artifact (409 on any difference), then sets `active_revision` in one statement and returns `{active, previous}`. Any app may activate, private and unlisted ones included. |
| `POST /v1/apps/:id/marketing/rollback` `{revision?}` | back to the named revision, or the most recently active one before the current, after the same integrity check. Refused when no site is active: an unpublished site is republished, never resurrected. |
| `GET /v1/apps/:id/marketing/deployments` | owner or admin: receipts (`app_marketing_deploys`, migration 0103) — revision, status, hashes, sizes, workflow run and commit, activation time, which one is live. |

Only a successful activation moves the pointer, so a failed build, upload,
manifest or verification leaves the previous site serving.

**Not yet aligned with this model.** These routes were built for the earlier
design (#399), in which the storefront repository built every site: they accept
only a GitHub OIDC token for audience `https://api.proappstore.online/marketing`
from `proappstore-online/proappstore`'s `marketing-deploy.yml` on main, and
`docs/storefront-marketing-deploy.yml` is that workflow's template. Under this
model the **app's own deploy** uploads, so the remaining platform work is:

1. accept the app repository's own deploy OIDC token for its own app id (the
   rule `lib/app-deploy-oidc.ts` already applies to the other keyless deploy
   steps), and retire the storefront-only pin and template;
2. add a step to the canonical deploy workflow (`packages/admin/src/publish.ts`
   `deployWorkflowYaml`, then `scripts/sync-template-workflow.mjs`) that builds
   the app's marketing template when present, uploads it and activates it,
   checking the live site and rolling back on failure;
3. add the template to `template-app`.

`app_storefront_publication.listed` (written by the admin publish step and
reconciled hourly from `registry.json`) remains the storefront catalogue's
listing state; it no longer affects the marketing site.

## Acceptance and release evidence

- An app with an active revision — public or private, listed or not — serves
  its one-page site with working images and CTA; the raw HTML contains the
  main heading and copy.
- Title, description, canonical, social image, robots and sitemap use the
  marketing URL. No hard-coded price or false claims.
- A failed build, upload or activation leaves the previous site intact; the
  deploy receipt shows each revision.
- Live: one public and one private app, after their deploys run — GET/HEAD,
  metadata, sitemap, CTA, images, a revision switch, unpublish and rollback.

## Work split

Tracked in [platform #397](https://github.com/proappstore-online/platform/issues/397).
[#409](https://github.com/proappstore-online/platform/issues/409) set this
model; [#399](https://github.com/proappstore-online/platform/issues/399) built
the host route and the upload/activation contract. The draft, approval and
build-snapshot parts of #398 and the console UI in
[console#8](https://github.com/proappstore-online/console/issues/8) are
superseded by this model. Do not close the epic from local tests or a green CI
run alone; it requires a live published site and revision/rollback evidence.
