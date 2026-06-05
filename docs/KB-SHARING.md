# KB Sharing

Knowledge Bases are **private by default**. The owner controls access via share links.

## Share link types

| Type | How it works | Use case |
|---|---|---|
| **Open link** | Anyone with the URL can view | Quick sharing, public docs |
| **Google auth** | Must sign in with Google, email on allowlist | Share with specific people by email |
| **GitHub auth** | Must sign in with GitHub, username on allowlist | Share with dev collaborators |
| **Password** | Link + password required | Share with non-tech stakeholders |

## Data model

```sql
CREATE TABLE kb_shares (
  id          TEXT PRIMARY KEY,        -- the share token (in the URL)
  project_slug TEXT NOT NULL,
  created_by  TEXT NOT NULL,           -- owner who created the share
  access_type TEXT NOT NULL,           -- 'open' | 'google' | 'github' | 'password'
  -- For google/github: comma-separated allowlist of emails/usernames
  allowlist   TEXT,
  -- For password: bcrypt hash
  password_hash TEXT,
  -- Metadata
  label       TEXT,                    -- optional name ("For investors", "Team access")
  expires_at  INTEGER,                -- optional expiry (epoch ms), NULL = never
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  view_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_kb_shares_project ON kb_shares(project_slug);
```

## URLs

```
kb.proappstore.online/<slug>/s/<share-id>           → access gate
kb.proappstore.online/<slug>/s/<share-id>/login      → Google/GitHub OAuth
kb.proappstore.online/<slug>/s/<share-id>/password    → password form
```

## Flow

1. Owner goes to Research tab → clicks "Share"
2. Picks access type + configures (allowlist or password)
3. Gets a URL: `kb.proappstore.online/<slug>/s/<share-id>`
4. Recipient opens the URL:
   - **Open**: KB renders immediately
   - **Google/GitHub**: redirected to OAuth, then back if email/username is on the allowlist
   - **Password**: shown a password form, KB renders after correct password
5. Owner can revoke any share link from the console

## Implementation

The KB is NOT published to R2 as static files anymore. Instead:

1. **Agent-teams DO** stores KB files in `project_files` table (already exists)
2. **KB access Worker** (new, at `kb.proappstore.online`) reads files from the DO via service binding
3. The Worker checks the share link's access policy before serving content
4. No static R2 publishing — all access is gated

## Phase 1 (build now)

- D1 table: `kb_shares`
- API: CRUD share links (agent-teams or backend)
- Console UI: "Share" button in Research tab with link type picker
- Access Worker: serves KB content after checking the share policy
- Open link type only (simplest, covers the main use case)

## Phase 2 (later)

- Google/GitHub OAuth on the access Worker
- Password-protected links
- View analytics (who accessed, when)
- Expiring links
