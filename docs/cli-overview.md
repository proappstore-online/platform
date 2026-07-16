# CLI overview

`@proappstore/cli` is the developer-facing command-line tool for creating,
checking, and publishing Pro apps.

## Install

```bash
npm i -g @proappstore/cli
```

Or run via `npx @proappstore/cli` for a one-off.

## Commands

```bash
# Auth
pas login                           # GitHub device auth; writes a PAS session
pas whoami                          # show current user
pas logout                          # clear session

# Create
pas create <app-id>                 # scaffold a new Pro app from the template
pas create <app-id> --repo org/name # scaffold + create GitHub repo + push

# Develop
pas check                           # run platform compliance checks locally

# Publish
pas publish                         # provision R2 route + D1 + Data Worker
pas publish --name "My App"         # with display name
pas publish --category productivity # with store category

# Integrations (one-command API setup)
pas integrate openai                # connect OpenAI — prompts for API key
pas integrate amadeus               # connect Amadeus — prompts for credentials
pas integrate list                  # show all available integrations

# Secrets & proxy (manual configuration)
pas secret set API_KEY <value>      # store an encrypted API key
pas secret list                     # list secret names (values never shown)
pas secret rm API_KEY               # delete a secret
pas proxy allow <pattern> --inject bearer --secret API_KEY
pas proxy list                      # show proxy allowlist
pas proxy deny <pattern>            # remove a proxy rule

# Custom domains
pas domain add my-custom.com        # add a custom domain
pas domain list                     # list configured domains
pas domain verify my-custom.com     # check DNS verification status
pas domain remove my-custom.com     # remove a custom domain

# Version
pas --version
```

## Create

`pas create` clones the template repo (`proappstore-online/template-app`),
replaces `APPNAME` placeholders, runs `pnpm install`, initializes git,
and optionally provisions D1 + Data Worker.

The `--repo` flag creates a GitHub repo and pushes in one step:

```bash
pas create flights --repo Flights-Stays/flights
```

Without `--repo`, you create the repo manually:

```bash
pas create flights
cd flights && pnpm dev
# When ready:
gh repo create my-org/flights --private --source . --remote origin --push
pas publish
```

## Check

`pas check` runs the same platform compliance checks locally that PAS uses
during app publishing and CI.

The current baseline includes:

- source safety checks, including no committed `.env.production` files and no
  third-party tracking SDKs
- PAS brand and viewport checks
- PWA metadata, manifest, offline, maskable icon, and share-image checks
- bundle-size checks after `pnpm build`
- baseline accessibility checks for images, buttons, and form controls

The accessibility rule is intentionally static so it can run quickly without a
browser. It catches missing image `alt` text, buttons without accessible names,
and unlabeled text-style form controls. Deeper audits such as color contrast,
focus order, keyboard traps, and rendered ARIA state should run in app tests
with Playwright and axe. PAS also runs the pinned VCQA code-health scanner in
generated app workflows as report-only guidance.

## Publish

`pas publish` reads `package.json` for the app ID, then calls `/v1/provision`
on the PAS backend, which provisions:

1. Compliance check (fetches the repo from GitHub, runs platform checks)
2. R2 route in the host Worker (`<id>.proappstore.online` → `apps/<id>/`)
3. D1 database (`pas-data-<id>`)
4. Data Worker (`data-<id>.proappstore.online`)
5. App record in the platform database (auto-seeds a developer profile)

Hosting is Path B: a single host Worker serves `*.proappstore.online` from R2 —
there is no per-app CF Pages project or per-app DNS record. Apps deploy via
GitHub Actions → R2 upload.

After a successful provision the CLI also registers MCP tools from `mcp.json`
(if present) and ensures the app repo's R2 deploy secrets (`R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`) — for `proappstore-online` repos it
dispatches the secret-reconcile workflow; external-org repos get printed
instructions.

Idempotent — re-running fills in only missing pieces.

## App Icons And Link Previews

The source of truth for an app's browser icon, installed PWA icon, and shared
link preview image is the app repo, not Creator Console.

Browser and install icons live in:

```text
web/public/icon-192.png
web/public/icon-512.png
```

Shared-link previews use a dedicated 1200x630 image:

```text
web/public/og-image.png
```

The template's `web/index.html` points Open Graph and Twitter metadata at:

```text
https://<app-id>.proappstore.online/og-image.png
```

When you share `https://<app-id>.proappstore.online`, social clients use that
deployed asset as the preview image. To change the shared-link preview, replace
`web/public/og-image.png` in GitHub and redeploy the app. New apps created with
`pas create` get a generated default `og-image.png`; production apps should
replace it with a branded preview image.

## Auth session

`pas login` uses GitHub device auth, exchanges the GitHub token for a PAS
session, and writes it to:

```text
~/.proappstore/config.json
```

The active session token lives at `session.token`. Commands also accept
`--token <token>` or `PAS_SESSION_TOKEN` when you need to run without the saved
CLI config.

## Source

- Package: `packages/cli` in the [platform monorepo](https://github.com/proappstore-online/platform)
- Built with `commander`
