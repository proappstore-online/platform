# Project Docs Sharing

Agent Teams projects produce private project docs: `KNOWLEDGE.md` plus markdown
under `docs/`. The public product term is **project docs**. Some implementation
names still use `kb_*` for historical reasons.

## Visibility

Project docs are private by default. The owner controls access through share
links from the Research tab.

## Share Link Types

| Type | How it works | Use case |
|---|---|---|
| Open link | Anyone with the URL can view | Quick sharing, public project docs |
| Google auth | Must sign in with Google, email on allowlist | Share with specific people by email |
| GitHub auth | Must sign in with GitHub, username on allowlist | Share with dev collaborators |
| Password | Link + password required | Share with non-technical stakeholders |

## Current Hosting Model

Project docs are published as Zensical static sites and served from the shared
docs host infrastructure:

1. Agent Teams writes `KNOWLEDGE.md` and `docs/*.md` in the project repo.
2. The admin publish flow injects a `kb.yml` workflow.
3. GitHub Actions runs `zensical build`.
4. Built files are uploaded to the shared R2-backed docs host.
5. The host serves generated pages for the project.

The platform docs site is `https://docs.proappstore.online/`. Per-project docs
currently use the historical host path `https://kb.proappstore.online/<slug>/`
until that route is renamed or aliased.

## Share-Link Data Model

The internal table name remains `kb_shares` until a schema migration renames it:

```sql
CREATE TABLE kb_shares (
  id            TEXT PRIMARY KEY,
  project_slug  TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  access_type   TEXT NOT NULL,
  allowlist     TEXT,
  password_hash TEXT,
  label         TEXT,
  expires_at    INTEGER,
  revoked       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  view_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_kb_shares_project ON kb_shares(project_slug);
```

## Share URL Flow

1. Owner opens the Research tab and clicks Share.
2. Owner picks access type and configures an allowlist or password if needed.
3. Platform creates a share URL for the project docs.
4. Recipient opens the URL:
   - Open links render immediately.
   - Google/GitHub links complete OAuth and then check the allowlist.
   - Password links render after the password succeeds.
5. Owner can revoke any share link from the console.

## Implementation Notes

- Use Zensical for generated documentation output.
- Keep `docs.proappstore.online` as the public platform documentation site.
- Treat `kb.proappstore.online` as a historical per-project-docs host name, not
  as the public product term.
- New UI text should say "project docs" or "docs", not "KB".
