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
pas publish                         # provision CF Pages + DNS + D1 + Data Worker
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

## Publish

`pas publish` reads `package.json` for the app ID, then provisions:

1. CF Pages project (`proappstore-<id>`)
2. DNS CNAME (`<id>.proappstore.online`)
3. Custom domain on the Pages project
4. D1 database (`pas-data-<id>`)
5. Data Worker (`data-<id>.proappstore.online`)
6. App record in the platform database
7. PAS proxy/secrets metadata for the app
8. Deploy secret on external-org repos (auto-sets `CLOUDFLARE_API_TOKEN`)

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
