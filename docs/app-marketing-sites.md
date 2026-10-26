---
description: "Understand generated app marketing sites, their public-content boundary and the deployment design at about-app origins."
---

# App marketing websites

Status: **design changed 2026-10-18** (#409, split from #398); the deploy path
landed with #408. Every app gets a
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
created per app. The template is `marketing/` in `template-app` (#407): Astro
and Tailwind pinned, copy and brand colours in `marketing/src/site.ts`, a home
page plus Privacy Policy and Terms; `pnpm build:marketing` writes
`marketing/dist/`.

## How an app publishes (#408)

The platform's reusable deploy pipeline (`.github/workflows/app-deploy.yml`,
which every app's `deploy.yml` calls, #427) has a **Publish marketing site**
step. With the default input `marketing: auto` it runs only when
`marketing/package.json` exists (`marketing: false` turns it off), after the
app itself is live in R2:

1. `pnpm --dir marketing build`;
2. hashes every file in `marketing/dist/` into an `artifact-manifest.json`
   (content types are the platform's `MARKETING_CONTENT_TYPES`; source maps are
   never published; any other file type fails the step);
3. uploads it as revision `${{ github.sha }}` and activates it, with the run's
   keyless GitHub OIDC token;
4. checks that `about-<app>` answers GET and HEAD `/` from the new revision
   (`X-PAS-Marketing-Revision`), and if it does not, rolls back to the revision
   the activation replaced.

The step is `continue-on-error`: a broken marketing build never blocks the app
deploy, and because only a successful, verified activation moves the pointer,
the previous site keeps serving. Editing the folder and pushing publishes a new
revision; re-running a deploy for the same commit is a no-op.

## Adding the site to an existing app: `pas marketing add` (#410)

New apps get `marketing/` from `template-app`. For an app created before it,
run in the app repo's root:

```bash
pas marketing add
pnpm --dir marketing install --ignore-workspace   # once
pnpm dev:marketing                                # preview locally
git add marketing package.json && git commit -m "Add marketing site" && git push
```

`pas marketing add` (`packages/cli/src/marketing.ts`):

- shallow-clones the default approved template (`template-app`) and copies its
  `marketing/` folder file by file — a file that already exists is **never
  overwritten**, only reported as skipped, so re-running it is safe;
- replaces `APPNAME` with the app id (from `.pas.json`, else the root
  `package.json` name) in the files it adds, and pre-fills
  `marketing/src/site.ts`: the app's name, headline, call to action and owner,
  and — from the app's public listing (`GET /v1/storefront/apps/:id`), when it
  has one — the summary (tagline), an https support link and the brand colours
  (theme colour, with darker and lighter shades derived from it). A private or
  unlisted app keeps the template's placeholders; review the copy before you
  push;
- adds root `dev:marketing` and `build:marketing` scripts
  (`pnpm --dir marketing --ignore-workspace …`) only if they are absent.

It leaves `pnpm-workspace.yaml` and the lockfile alone: `marketing/` is a
standalone package with its own `pnpm-lock.yaml`, so the app's
`pnpm install --frozen-lockfile` is unaffected, and the deploy step installs
it on its own (`pnpm --dir marketing install --ignore-workspace`).

The next push publishes it **if the app's `.github/workflows/deploy.yml` has
the "Publish marketing site" step**; the command says so when it does not. An
app on an older workflow needs it updated to the canonical one first.

### Over MCP: `add_marketing_site` (#421)

The same thing without a checkout: `add_marketing_site { app_id }` on
`mcp.proappstore.online/mcp` (owner only; `dry_run: true` previews the plan).
It reads `template-app`'s `marketing/` through the GitHub API, skips every file
the app repo already has, applies the same `APPNAME` replacement, `site.ts`
pre-fill (`prefillSite` in `packages/build-core/src/marketing-site.ts`, held
equal to the CLI's copy by its test) and root scripts, and commits the result
to `main` in **one** commit, so the push deploys it. Binary files (the icon)
go in that same commit as base64 blobs. It reports whether `deploy.yml`
publishes the site, as the CLI does; it never writes under `.github/`.

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
- Paths map as Astro builds them: `/` and a directory path (`/privacy/` or
  `/privacy`) are that directory's `index.html`; other files are served as
  named (`/icon-192.png`, `/_astro/*.css`, `/assets/*`). Every segment must be
  a plain name, the extension one the platform publishes (HTML, CSS, XML,
  text, PNG, JPEG, WebP, ICO, SVG, WOFF2), and HTML only as `index.html`.
  Dotfiles, `..`, source maps, scripts, the artifact manifest and anything not
  in the revision are a real 404, never the app's SPA fallback. R2 keys are
  built from the hostname's own app id only.
- GET and HEAD, with accurate content types and ETag/304. Nothing is
  edge-cached: every response is `public, max-age=0, must-revalidate`, so a
  revision switch or an unpublish is seen on the next request. Responses carry
  a static-site CSP (`default-src 'none'`, `script-src 'self'`,
  `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, HSTS and the
  serving revision in `X-PAS-Marketing-Revision`.

## Upload, activation and rollback (`packages/backend/src/routes/marketing-deploy.ts`)

Every write route takes the same credential as the app's other keyless deploy
steps (`lib/app-deploy-oidc.ts`): a GitHub Actions OIDC token for audience
`https://api.proappstore.online` from the app's own repository on main. A
repository can only write its own app's site; no standing secret is involved.

| Route | Effect |
|---|---|
| `PUT /v1/apps/:id/marketing/revisions/:revision` | multipart: `manifest` (`artifact-manifest.json`) plus one part per listed path. The revision must be the commit the run is building. Every file must match its size and SHA-256 and be a path the host serves; only `/index.html` is required (`robots.txt` and `sitemap.xml` are optional). The files, then the manifest, go to `marketing/<id>/revisions/<revision>/`. Never activates. A revision is immutable: the same bytes again are a no-op, other bytes a 409. |
| `POST /v1/apps/:id/marketing/activate` `{revision}` | re-reads and re-hashes the stored artifact (409 on any difference), then sets `active_revision` in one statement and returns `{active, previous}`. Any app may activate, private and unlisted ones included (#409). |
| `POST /v1/apps/:id/marketing/rollback` `{revision?}` | the app's deploy or a platform admin: back to the named revision, or the most recently active one before the current, after the same integrity check. Refused when no site is active: an unpublished site is republished, never resurrected. |
| `GET /v1/apps/:id/marketing/deployments` | owner or admin: receipts (`app_marketing_deploys`, migration 0103) — revision, status, hashes, sizes, repository, workflow run and commit, activation time, which one is live. |

`app_storefront_publication.listed` (written by the admin publish step and
reconciled hourly from `registry.json`) is the storefront catalogue's listing
state; it does not affect the marketing site.

**Rollout.** Every app whose `deploy.yml` calls the reusable pipeline has the
step (#427). An app still on a copied workflow gets it by replacing that file
with the thin caller from `template-app`; the `deploy-workflow` compliance
check names those apps.

## Enquiries (#412, epic #411)

A marketing site can carry an enquiry form. Submissions are stored in the
platform per app (`app_enquiries`, migration 0104), never emailed out and never
in the app's own data, and every app takes them, private ones included.

| Route | Caller | Effect |
|---|---|---|
| `POST /v1/apps/:id/enquiries` | the `about-<id>` site | `name` (≤ 100), `email` (≤ 254, an address), `message` (≤ 5,000). A plain HTML form (`application/x-www-form-urlencoded`) is answered with a 303 to `https://about-<id>.proappstore.online/?enquiry=<outcome>#enquiry-<outcome>` (`sent`, `invalid` or `rate-limited`), so the form can show the outcome with CSS `:target` and no JavaScript; JSON callers get 201/400/429. |
| `GET /v1/apps/:id/enquiries?status=new\|handled&before_id=&limit=` | owner or admin | newest first (≤ 100; same-millisecond arrivals in insertion order, #431), plus `counts: { new, total }` and `next: { before_id }` when the page is full. Pass `next.before_id` for the following page; the older `before=<timestamp>` still works but can skip rows that share the boundary millisecond. |
| `GET /v1/apps/:id/enquiries/:enquiryId` | owner or admin | one enquiry. |
| `PATCH /v1/apps/:id/enquiries/:enquiryId` `{status}` | owner or admin | `new` or `handled`; records who handled it and when. |

Spam protection: the POST must carry `Origin: https://about-<id>.proappstore.online`
(403 otherwise); a filled `website` honeypot field is answered like a success
and stored nowhere; at most 5 enquiries per client IP per app per hour and 200
per app per day are stored (429 with `Retry-After`). The client IP is kept only
as a SHA-256 hash of app id and IP, for that limit. The marketing site's CSP
allows `form-action https://api.proappstore.online` for this form and nothing
else.

Owners read enquiries over MCP with `list_enquiries` (status filter, `next.before_id`
cursor), `get_enquiry` and `mark_enquiry_handled` (`handled: false` reopens). The tools
call the owner-or-admin routes above with the connection's own session, so a
non-owner gets the backend's 403 (#413).

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
