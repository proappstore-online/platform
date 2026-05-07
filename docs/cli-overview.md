# CLI overview

`pas` is the publisher-facing command-line tool. It mirrors the free
side's `fas` CLI, with extras for paid features.

> **v0 status: skeleton.** Command shapes are defined; some subcommands
> currently print "TODO" and return.

## Install

```bash
npm i -g @proappstore/cli
```

Or run via `pnpx @proappstore/cli` for a one-off.

## Commands

```bash
pas login                         # GitHub device-flow auth (shared with fas)
pas init <name>                   # scaffold a new pro app from a template
pas publish                       # provision repo + Pages + DNS + (Tailored) D1 + registry
pas list                          # list apps you've published
pas doctor                        # diagnose local setup
pas logs <app>                    # tail Cloudflare logs for an app

pas stripe link                   # connect a Stripe account to publish paid features
pas stripe price create           # interactive: create a Stripe price for an app
pas license mint <app>            # mint a license key (interactive, prompts for email + metadata)
pas license revoke <key>          # revoke a license key
```

## Init templates

`pas init` scaffolds from the relevant template. Two starting points,
matching the [two categories](/tailored-vs-ready):

```bash
pas init pipeline --tailored      # B2B back-office Tailored template
pas init events --ready           # multi-tenant Ready template
```

The `--tailored` / `--ready` flag drives:

- Which template repo is cloned + scrubbed.
- Which `wrangler.toml` shape lands (Tailored: own D1; Ready: BYO).
- What `package.json` scripts are wired (`db:migrate:remote` only for
  Tailored).
- What the README says about the customization motion.

`pas init <name>` without a category flag prompts.

## Publish

`pas publish` reads `pas.config.json` (created by `pas init`), validates
it, then calls the `pas` Worker, which calls the `fas` Worker, which
calls `fas/admin` over the service binding. See [publishing
flow](/publishing-flow) for the sequence.

Required config:

```json
{
  "appId": "pipeline",
  "name": "Pipeline",
  "category": "tailored",
  "store": "apps"
}
```

`pas publish` is idempotent — re-running on an already-published app
re-syncs the registry entry but does not recreate the repo / Pages
project / D1.

## Pairing with `fas`

`pas` shares auth with `fas`. Once you `pas login` (or `fas login`), the
session lives in `~/.config/freeappstore/session.json` and both CLIs
read it. No second login.

Some `pas` commands (`pas init`, `pas publish`) end up calling `fas`
internally — for example, `pas publish` is just `fas publish` plus a
category flag plus Stripe wiring. Calling `fas publish` directly with
`--category tailored` works too; `pas` is a friendlier wrapper.

## Source

- Package: `~/personal/proapps/sdk/packages/cli`
- Built with `commander` + `prompts` for interaction
- TUI screens (Ink-based) under `src/tui/screens` for richer flows
