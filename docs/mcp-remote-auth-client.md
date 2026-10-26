---
description: "Connect a headless machine's MCP client with pas mcp-auth and approve sign-in on a phone without a localhost callback."
---

# Remote MCP sign-in: the machine client (`pas mcp-auth`, #356)

`pas mcp-auth` connects a **headless** machine's MCP client to ProAppStore. You approve it on your phone.
There is no browser on the machine, no localhost callback and nothing to copy through chat. It is the
client half of the broker in [mcp-remote-auth-broker.md](./mcp-remote-auth-broker.md) (#355). It uses
the ProAgentStore relay (ProAgentStore #1005, `docs/remote-auth-relay.md` in that repo) to send your
phone a notification for the one request.

## Requirements

| What | Minimum | Why |
|---|---|---|
| `@proappstore/cli` (`pas`) | the release that includes this command | — |
| A `pas login` session on the machine | — | The request is created with your own account (broker v2 `POST /requests` takes the owner's PAS bearer). Without one the command stops and says so. |
| `pags` (ProAgentStore CLI), signed in | **0.4.121** | First release with `pags remote-auth`. Older or missing: a clear error. `--no-relay` skips the notification; you then open the printed approval link yourself. |
| Codex | **0.162.1** (verified) | `codex mcp add <name> --url <url> --bearer-token-env-var <VAR>`: a streamable-HTTP server whose bearer comes from an environment variable. |

## Use

```bash
pas mcp-auth connect                     # platform MCP (/mcp)
pas mcp-auth connect --app stash         # one app's MCP (/mcp/apps/stash)
```

1. The machine creates a request at ProAppStore and relays its **public** details to ProAgentStore.
   Your phone gets "Approve a ProAppStore sign-in". The command also prints the ProAppStore approval
   link, which carries only the request id.
2. On the phone, check the agent, machine and service, sign in at ProAppStore with GitHub or Google, and
   approve.
3. The machine picks up the result by itself. It proves the new credential with a harmless
   authenticated MCP call, stores it, and only then reports *connected*.

Then, once, register it with Codex as a **separate** server. Your existing entries and their logins
are untouched:

```bash
codex mcp add proappstore-remote --url https://mcp.proappstore.online/mcp --bearer-token-env-var PAS_REMOTE_MCP_TOKEN
pas mcp-auth exec -- codex               # Codex, with the credential in its environment only
```

`pas mcp-auth status` shows the connection and its expiry, never the credential.
`pas mcp-auth disconnect` forgets it on this machine only; no global logout. `--name` keeps several
connections apart. The default name is `proappstore-remote`.

## What it guarantees

- **Secrets stay on the machine.** The machine proof, PKCE verifier and P-256 private key never leave it.
  Only their hash, the challenge and the public key are sent when the request is created. The result
  arrives ECDH-encrypted to this machine's key. Nothing secret is printed, put in a URL, relayed, logged
  or placed in an error message.
- **The relay carries the documented public fields only:** request id, agent, machine, resource,
  `scopes: []`, approval URL and expiry. Any other key, at any depth, makes the CLI refuse the relay
  before it leaves the machine. So does an approval URL with parameters.
- **Your current connection survives** until the new one has made an authenticated MCP call. Only then is
  `~/.proappstore/mcp/<name>.json` replaced atomically (temp file, then rename; mode 0600, directory 0700).
  If the call fails, the broker is told `failed` and the previous credential is kept.
- **One attempt at a time.** A second `connect` while one runs is refused, naming the process. A lock
  left by a process that has gone is taken over.
- **A restart resumes the same request.** The open attempt is kept 0600 next to the credential. A
  machine that lost its network, or was restarted, picks up the same request: no second request, no
  second notification. Redemption uses one attempt id kept across retries and restarts, so a lost answer
  is recovered without minting twice.
- **Waiting is bounded.** It polls no faster than every 2 s, honours `slow_down`, backs off to 30 s on
  network loss, and stops at the request's expiry (10 minutes).

## Errors you may see

| Message (abridged) | Meaning |
|---|---|
| "This machine has no ProAppStore session. Run `pas login`…" | No PAS session to create the request with. |
| "`pags` 0.4.x has no `remote-auth` command…" / "…was not found…" | Update or install the ProAgentStore CLI, or use `--no-relay`. |
| "Another sign-in … is already running (process N)" | A concurrent start. Wait, or stop that process. |
| "The sign-in was denied / cancelled at ProAppStore." | Your choice on the phone. Nothing changed on the machine. |
| "The sign-in request expired…" | Nobody approved within 10 minutes. Run it again. |
| "ProAppStore no longer accepts this sign-in request…" | The broker's deliberate catch-all: wrong machine, wrong owner, unknown request, replay or stale state all look the same. Start a new one. |
| "Lost the connection to ProAppStore…" | Still offline after repeated retries. Run it again when online: it resumes. |
| "The new connection could not make an authenticated … MCP call. Your previous connection is unchanged." | The health check failed. Nothing was replaced. |

## Cross-repo dependencies

- **ProAgentStore runner.** A `pags up` runner that launches Codex for you must start it through
  `pas mcp-auth exec -- codex …`, or otherwise set `PAS_REMOTE_MCP_TOKEN` from the stored credential, for
  the Codex entry above to authenticate. That is a ProAgentStore runner change; this repo does not make it.
  Codex also lists an `http_headers_helper` setting; it is not a documented `codex mcp add` flag, so this
  client does not rely on it.

## Verified, and what is not

- **Verified here (synthetic):** the whole client protocol against a fake broker that keeps the broker's
  rules and seals with the broker's own `seal`, a fake phone, a fake MCP endpoint and a fake `pags`. That
  covers the happy path; denied, cancelled and expired requests; wrong machine, wrong owner and wrong
  request; lost-answer redemption and double redemption; concurrent starts; old and missing `pags`; network
  loss and offline/reconnect resume; credential preservation on a failed health check; relay refusals; and
  no secrets in any output (`packages/cli/src/mcp-remote-auth*.test.ts`). Codex 0.162.1 accepted the printed
  registration in an isolated `CODEX_HOME`.
- **Not verified, needs the owner:** a real approval on a real phone (push → request page → external browser
  → Google/GitHub consent), a real credential reaching a real Codex session, and the runner launching Codex
  with it. These need a real OAuth grant and a device. They are tracked by ProAgentStore #1006.
