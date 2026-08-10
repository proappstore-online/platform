-- Optional email as a second sign-in identifier for credential accounts (0029).
-- An adult provisioned as a credential account — a teacher with no GitHub or
-- Google login — signs in with an email they already remember instead of an
-- animal triple. Children keep the triple: it is the COPPA privacy feature
-- 0029 describes, and this column stays NULL for them (enforced in
-- routes/auth.ts, which rejects an email on an is_child account).
--
-- Deliberately NOT the existing `users.email` (0021). That column holds the
-- address an OAuth provider asserted, i.e. one a provider verified. This one
-- is typed in by the provisioning adult and is NEVER verified by us, so the
-- two must not be interchangeable. Nothing may authorize off this column: it
-- is an identifier for finding the row, and the password remains the only
-- proof. (As of this migration nothing in the codebase resolves a user by
-- email at all — engagements.ts reads `email` for a known id, roles.ts matches
-- on LOWER(login). Keep it that way.)
ALTER TABLE users ADD COLUMN credential_email TEXT;

-- One account per email, same partial-index shape as idx_users_credential_login
-- (0029): OAuth rows and child rows leave this NULL, so they neither collide
-- with each other nor bloat the index. SQLite compares TEXT byte-wise, so
-- uniqueness only holds if callers store the normalized (trim + lowercase)
-- form — see normalizeEmail in lib/credential-gen.ts. Storing a raw
-- "Teacher@School.edu" here would sit alongside "teacher@school.edu" as a
-- second, separately-loginable account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_credential_email
  ON users(credential_email) WHERE credential_email IS NOT NULL;
