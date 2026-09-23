# Worked examples

Five decisions in the output template's shape, one per evaluation scenario.

## simple-crud — a personal notes app

Requirements: one user's notes with tags, search, a favourites count; Tailored
or single-user; no sharing.

| Need | Decision | Clause |
|---|---|---|
| notes, tags | D1 via actions `list_notes`, `create_note`, `update_note`, `delete_note`, all `user_id = :__user_id` | [PAS-STACK-007](https://docs.proappstore.online/standard/stack/#pas-stack-007), [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007) |
| search | `search_notes` with `LIKE '%' \|\| :q \|\| '%'` and a bounded `LIMIT` | [PAS-DATA-005](https://docs.proappstore.online/standard/data/#pas-data-005), [PAS-DATA-010](https://docs.proappstore.online/standard/data/#pas-data-010) |
| favourites count | `app.counters` if shared; otherwise a column | [PAS-STACK-010](https://docs.proappstore.online/standard/stack/#pas-stack-010) |
| theme / layout preference | `app.kv` | [PAS-STACK-009](https://docs.proappstore.online/standard/stack/#pas-stack-009) |

Trade-off: KV would be simpler for notes but has no query and a 100-key cap;
D1 actions cost an `mcp.json` entry each and give search, export and MCP
access for free. Unsupported: none. Recipe: `crud-list`, `search-filter`.

## multi-tenant — an agency CRM (Ready app)

Requirements: agencies (orgs) with members and roles, leads and notes per org,
CSV export, a manager-only delete.

| Need | Decision | Clause |
|---|---|---|
| org isolation | every statement scoped with `org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id)`; `org_members` in `migrations.json` | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007), [PAS-STACK-011](https://docs.proappstore.online/standard/stack/#pas-stack-011) |
| roles | `app.roles` for app-wide roles; org role in `org_members.role`, checked in SQL; `auth.app_roles` on privileged actions | [PAS-AUTH-013](https://docs.proappstore.online/standard/auth/#pas-auth-013), [PAS-AUTH-014](https://docs.proappstore.online/standard/auth/#pas-auth-014) |
| onboarding | `app.invites.create({ role, group })` | [PAS-AUTH-015](https://docs.proappstore.online/standard/auth/#pas-auth-015) |
| org create + first membership | one **batch** action | [PAS-DATA-009](https://docs.proappstore.online/standard/data/#pas-data-009) |
| export | scoped, paginated `export_org_leads` | [PAS-DATA-012](https://docs.proappstore.online/standard/data/#pas-data-012) |

Trade-off: a Tailored fork per agency would avoid tenancy SQL but loses
shared onboarding and cross-org features; Ready keeps one deployment and pays
with a membership sub-query on every statement — tested by cross-tenant
negatives ([PAS-DATA-022](https://docs.proappstore.online/standard/data/#pas-data-022)). Unsupported:
none. Recipe: `roles-rbac`, `data-table`.

## realtime-collab — a shared whiteboard

Requirements: live cursors and chat for up to 20 people per board, boards
persist, a board owner can lock it.

| Need | Decision | Clause |
|---|---|---|
| cursors, chat | `app.rooms.join(\`board:${id}\`)`; messages validated, `from` is the only trusted field | [PAS-STACK-013](https://docs.proappstore.online/standard/stack/#pas-stack-013), [PAS-DATA-017](https://docs.proappstore.online/standard/data/#pas-data-017) |
| board content | `save_stroke` / `load_board` actions (durable record) | [PAS-DATA-017](https://docs.proappstore.online/standard/data/#pas-data-017) |
| lock | `lock_board` with `WHERE owner_id = :__user_id`; clients honour it, the action enforces it | [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008) |

Trade-off: 20 peers fits the 32-peer cap; strokes through actions add latency
but survive reloads and are auditable. Unsupported: a server-authoritative
canvas (conflict resolution on the server) — flag it; interim: last-write-wins
by action timestamp. Recipe: `realtime-chat`.

## file-heavy — a document library

Requirements: PDFs and images up to 40 MB, private by default, shareable
public links, per-folder permissions, previews.

| Need | Decision | Clause |
|---|---|---|
| files | `app.storage.upload` (private) / `uploadPublic` for shared links; key + metadata rows in D1 via actions | [PAS-STACK-012](https://docs.proappstore.online/standard/stack/#pas-stack-012), [PAS-DATA-013](https://docs.proappstore.online/standard/data/#pas-data-013) |
| type/size checks | `accept` list + client checks; platform refuses HTML/JS/SVG and > 50 MB | [PAS-UI-016](https://docs.proappstore.online/standard/ui/#pas-ui-016) |
| folder permissions | `folder_members` + membership sub-queries on every `list_files`/`get_link` | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007) |
| previews | images via `<img>`, PDFs as downloads — never rendered as active content | [PAS-UI-016](https://docs.proappstore.online/standard/ui/#pas-ui-016) |

Trade-off: public links are permanent URLs — model "unshare" as deleting the
public copy. Unsupported: server-side thumbnails/transcoding — interim: render
previews client-side. Recipe: `file-upload`.

## background-work — tournament pairings that expire

Requirements: games idle for 15 minutes must be marked abandoned so a round
can complete, even if nobody is watching.

| Need | Decision | Clause |
|---|---|---|
| the sweep | a `reap_stale_games` action: idempotent, `LIMIT`-bounded, gated to `coach`, scoped by club membership | [PAS-DATA-019](https://docs.proappstore.online/standard/data/#pas-data-019), [PAS-DATA-018](https://docs.proappstore.online/standard/data/#pas-data-018) |
| trigger | run on load of the staff view; document in the README | [PAS-DATA-019](https://docs.proappstore.online/standard/data/#pas-data-019) |
| the gap | scheduled execution is **unsupported** — cite #123; do not add browser timers or an external cron | [PAS-DATA-019](https://docs.proappstore.online/standard/data/#pas-data-019) |

Trade-off: the round completes only when a coach is present; that is the
honest limit until Pro cron exists. Unsupported: cron (#123); verifying a
checkmate claim server-side (#148).
