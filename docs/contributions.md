---
description: "Project contributions by lines of code: the verified-repository ledger, ingestion, counting policy and read API (#544 to #547)."
---

# Project contributions (lines of code)

Who wrote how much of a project, measured as lines added and removed in the app's own repository. This is the
platform contract of epic #544: the ledger (#545), the history ingestion (#546) and the authorized read API (#547).
Console and storefront screens are separate work, and so is any use of these numbers for anything but reading them.

**These are code-activity metrics.** They do not grant, remove or change access, a role, ownership, a payout or a
revenue rule, and no PAS identity is merged or inferred from them. Lines of code are a coarse signal: a revert, a
large generated change or a reformat can move them, which is why the policy and the exclusions below are explicit.

## What is counted

Policy **v1** (`policy_version` is on every response; a changed rule is a new version and stored facts are recomputed
under it, never silently mixed):

- Added and removed lines in **source and test files** of **non-merge commits reachable from the repository's current
  default branch**, each commit **once**. A merge commit is recorded but adds nothing, so its combined diff never
  double-counts the commits it brings in. A squash counts once; a revert counts as its own removals and stays visible.
- **Tests count. Documentation does not** (`md`, `mdx`, `rst`, `txt`, `adoc`).
- **Not counted:** lockfiles, generated or build output (`dist`, `build`, `coverage`, `.next`, minified files, source
  maps), vendored dependencies (`node_modules`, `vendor`, `third_party`), binary and media files, and files GitHub
  returned no diff for. A commit whose every file is excluded has nothing eligible and is not an eligible commit.
- **Authorship** is the commit's **author**, as the numeric GitHub account GitHub linked to it. `Co-authored-by`
  trailers are counted (`co_authored_commits`) but **never credited**: a co-author never receives a second full credit.
- The **period** is by the commit's author date in UTC, half-open: `from <= date < to`.
- A commit GitHub would not list completely (more than 3000 files) is flagged (`truncated_commits`) rather than
  presented as exact.

## Who is who

- **People** are GitHub accounts, keyed by the **numeric account id**, so a renamed login is the same person. `matched`
  says that id is also a PAS user; **unmatched** accounts are still listed, flagged `matched: false`. Nothing is matched
  by name, email or membership, and no raw author email is stored or returned.
- **Bots** (`type: Bot` or a `[bot]` login) and commits GitHub **linked to no account** are separate buckets
  (`buckets.bots`, `buckets.unlinked`). They count towards the total, so a person's share is honest, and are never
  merged into a person.
- A person's **share** is *their added lines ÷ all eligible added lines in the period* (people, bots and unlinked
  together). A zero total gives `ratio: 0, percent: 0`, never `NaN`.
- People are ranked by additions, then by GitHub account id ascending, so the order is total and stable.

## The repository is the platform's, not the caller's

The repository is **derived** from the app: `proappstore-online/<appId>`, with the one transferred app
(`chess-academy` → `ChessClubs-online/chess-clubs`) pinned, matching the deploy identity. No request, query or body
can name another repository. Its **immutable GitHub id** is recorded the first time it is read and is the identity
from then on. If the same name later resolves to a different id (a deleted and recreated or transferred repository),
reading **stops** with `identity_changed` and the app reads `unavailable`; it is never silently re-bound. A rename with
the same id keeps working.

## Ingestion

- Facts are one row per **(repository id, SHA)** in `project_commits`, so replays, concurrent workers and renames cannot
  count a commit twice. Sync state (freshness, backfill completion, errors, rewrite detection) is kept apart from the
  facts, so "no commits", "not read yet" and "could not read" are different answers.
- A run is **bounded** (a fixed number of commit-detail reads per run, 100 commits per list page) and **checkpoints
  after each page**. The listing is pinned to the head the walk started from, so pushes during a multi-run backfill
  cannot shift pages. One worker per project at a time (a lease); a stale lease is reclaimed.
- **Incremental refresh** reads only commits newer than the last head. A **force-push or history rewrite**, or a
  **default-branch change**, triggers a full walk: commits no longer reachable are marked `reachable = 0`, kept as audit
  facts, and excluded from every aggregate (`excluded.unreachable_commits`).
- **Rate limits, revoked access and transient errors** are recorded as such (`rate_limited_until`, `access_lost`, a
  backoff). They never become a zero and never mark a backfill complete; figures already read are kept and served
  `stale`.
- **Refresh mode is `scheduled`.** Platform-provisioned repositories have no push webhook, so the platform re-reads
  each repository from its five-minute tick (a few projects per tick), and the owner can request a refresh. Figures can
  lag a push by the refresh interval; `freshness` says when the last good read was and when the next is due. A webhook
  would only shorten that lag; the repairable states are the same without one.

## API

All reads need **access to the app** (`viewer` or above on the team), including for a public app: a team's figures
stay private. A signed-in non-member gets `403`, an unknown app `404`. Responses are `private, no-store`.

| Route | |
| --- | --- |
| `GET /v1/apps/:appId/contributions` | Summary: state, freshness, policy, totals, buckets, exclusions. `?from=&to=` |
| `GET /v1/apps/:appId/contributions/people` | Ranked people, one page. `?from=&to=&limit=&cursor=` |
| `GET /v1/apps/:appId/contributions/policy` | The counting policy in force |
| `POST /v1/apps/:appId/contributions/refresh` | **Owner only.** Starts a bounded read now; `202`, `503` if reads are not configured |

`from` and `to` are an ISO date (UTC midnight), an ISO date-time with a zone, or epoch milliseconds. `limit` is 1 to 100
(default 25). `cursor` is opaque (`rank.additions.id`) and is returned as `next.cursor` until the last page (`next:
null`). Bad values are `400`.

### States

Every response says what it is, with `state` and a plain `state_reason`:

| `state` | Meaning |
| --- | --- |
| `unavailable` | The repository has not been read yet, or its identity changed. No figures. |
| `error` | Reading has failed and nothing has ever been read. |
| `partial` | The history is still being read. Figures are what is known so far; `complete` is `false`. |
| `stale` | The whole history was read, but the last refresh failed or is older than expected. Last good figures are shown. |
| `empty` | The **whole** history was read and holds nothing eligible in the period. |
| `ok` | Complete and fresh. |

`complete` is true only when the full history was read. A UI must not present `partial`, `error` or `unavailable`
as a zero.

### People row

```json
{ "rank": 1, "github_account_id": 501, "github_login": "ada", "matched": true, "user_id": "gh:501",
  "additions": 80, "deletions": 5, "commits": 2, "last_commit_at": 1773532800000,
  "share": { "numerator": 80, "denominator": 100, "ratio": 0.8, "percent": 80 } }
```

## Not here

- **No MCP tool or SDK method yet.** Exposing these reads there is a follow-up; the API above is the contract it will
  wrap, and it would be read-only with no mutation or payout.
- **No Console screen** (that is Console #13) and no storefront display.
- **Live acceptance is not recorded.** The ingestion is tested against deterministic scripted histories, never against
  live GitHub. A real repository's figures, the first scheduled backfill and the production token's behaviour have not
  been observed by this change.
