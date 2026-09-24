-- Personal app tokens (#154): long-lived, per-user, per-app, revocable bearer
-- tokens (`pas_at_…`) accepted by the HTTP actions route only. Only the SHA-256
-- of the token is stored; the plaintext is shown once at mint. `token_id` is a
-- separate random id so lists and revokes never touch the hash (and a revoke is
-- an exact match on id + user + app — never a LIKE on a prefix). `scopes` is JSON
-- {"access":"read"|"write","actions":null|[…]}; `created_origin` records which
-- origin minted the token so the dashboard can show where it came from.
CREATE TABLE IF NOT EXISTS user_app_tokens (
  token_hash     TEXT PRIMARY KEY,
  token_id       TEXT NOT NULL UNIQUE,
  user_id        TEXT NOT NULL,
  app_id         TEXT NOT NULL,
  label          TEXT,
  scopes         TEXT NOT NULL,
  created_origin TEXT,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_app_tokens_user ON user_app_tokens (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_app_tokens_app_user ON user_app_tokens (app_id, user_id, created_at DESC);
