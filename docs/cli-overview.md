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
pas login                           # GitHub OAuth sign-in (shared session with fas)
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
7. Cross-registration in FAS (enables proxy + secrets)
8. Deploy secret on external-org repos (auto-sets `CLOUDFLARE_API_TOKEN`)

Idempotent — re-running fills in only missing pieces.

## Shared auth with FAS

`pas` shares auth with `fas`. Both CLIs read the session from
`~/.config/freeappstore/session.json`. One `pas login` (or `fas login`)
covers both.

## Source

- Package: `packages/cli` in the [platform monorepo](https://github.com/proappstore-online/platform)
- Built with `commander`
