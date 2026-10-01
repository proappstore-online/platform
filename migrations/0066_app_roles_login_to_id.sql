-- #272 follow-up (PR #273 review): rewrite legacy app_roles rows keyed by a
-- GitHub LOGIN to the holder's PAS user id (`gh:<id>`).
--
-- Role checks still match a GitHub session's login as an alias for these rows
-- (lib/role-subject.ts), but a login is mutable: once its owner renames, the
-- next person to take that login on GitHub inherits the grant. Keying the row
-- by the immutable id closes that and lets the alias retire later.
--
-- Scope, and what is deliberately left alone:
--   * Only rows whose user_id contains no ':' are legacy. Every PAS id is
--     prefixed (gh:, google:, cred:) and a GitHub login cannot contain ':'.
--   * A row is rewritten only when EXACTLY ONE users row has provider='github'
--     and that login (exact, case-sensitive — the same comparison role checks
--     make today). Zero matches (holder never signed in, or renamed since) or
--     more than one (a stale login recorded on two accounts) stay as they are
--     and keep working through the alias; the PR body has the read-only query
--     that counts them.
--   * If the holder already has the same role by id, the id row is kept
--     (INSERT OR IGNORE) and the legacy duplicate is deleted.
--
-- Idempotent: a second run finds no remaining legacy row with a unique match,
-- so both statements change nothing. Runs on the live database at deploy
-- (deploy-backend.yml applies migrations before the worker deploys); the old
-- worker keeps matching gh: sessions by id in the meantime, so no grant is
-- unreadable at any point.

INSERT OR IGNORE INTO app_roles (app_id, user_id, role_name, granted_by, granted_at)
SELECT r.app_id, u.id, r.role_name, r.granted_by, r.granted_at
  FROM app_roles r
  JOIN users u ON u.provider = 'github' AND u.id LIKE 'gh:%' AND u.login = r.user_id
 WHERE instr(r.user_id, ':') = 0
   AND (SELECT COUNT(*) FROM users c WHERE c.provider = 'github' AND c.id LIKE 'gh:%' AND c.login = r.user_id) = 1;

DELETE FROM app_roles
 WHERE instr(user_id, ':') = 0
   AND (SELECT COUNT(*) FROM users c WHERE c.provider = 'github' AND c.id LIKE 'gh:%' AND c.login = app_roles.user_id) = 1;
