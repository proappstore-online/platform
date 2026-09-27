-- Passkey step-up (#230, part of #228). A user registers a passkey on an app
-- origin (rp_id = that hostname); the host's /.pas/auth/passkey/step-up then
-- re-authenticates them with it and swaps in a short-lived session carrying a
-- fresh auth_time.
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id           TEXT PRIMARY KEY,           -- credential id, base64url
  user_id      TEXT NOT NULL,
  rp_id        TEXT NOT NULL,              -- the app hostname it was registered on
  public_key   TEXT NOT NULL,              -- SPKI, base64url
  alg          INTEGER NOT NULL,           -- COSE: -7 ES256, -257 RS256
  sign_count   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_rp ON passkey_credentials (user_id, rp_id);

-- One-time WebAuthn challenges: consumed (deleted) on use, 5-minute life.
CREATE TABLE IF NOT EXISTS passkey_challenges (
  challenge  TEXT PRIMARY KEY,             -- base64url, 32 random bytes
  user_id    TEXT NOT NULL,
  rp_id      TEXT NOT NULL,
  purpose    TEXT NOT NULL,                -- 'register' | 'step-up'
  expires_at INTEGER NOT NULL              -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_passkey_challenges_user ON passkey_challenges (user_id);
