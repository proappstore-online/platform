-- One-time codes for the server-to-server login handoff (#87, #110).
--
-- Two flows asked the backend to deliver the session JWT as a URL *query*
-- parameter (`?session=…`): the host's `/.pas/auth/callback` and the MCP
-- worker's `/oauth/callback`. Unlike the fragment the browser flow uses, a
-- query string reaches servers — it lands in Cloudflare request logs, Referer
-- headers and browser history — and the value is a directly reusable Bearer for
-- the life of the session. This is why OAuth returns a short-lived, single-use
-- authorization code in a redirect rather than a token, and why the implicit
-- flow was deprecated in OAuth 2.1.
--
-- This table replaces that with a code exchanged server-to-server. Three
-- choices worth noting:
--
--   * We store the code's HASH, never the code. Read access to this table
--     yields nothing that can be presented.
--   * We store CLAIMS, not a minted token, and sign at exchange time — so no
--     usable credential exists at rest even briefly, and a code that is never
--     exchanged produces no session at all.
--   * The claims are computed at redirect time, NOT at exchange time, because
--     the role decision depends on the destination host: #56 de-privileges any
--     session delivered to an app origin, and the exchange endpoint no longer
--     knows where the browser was headed. Deciding roles later would silently
--     re-privilege app-origin sessions and undo that fix.
CREATE TABLE IF NOT EXISTS auth_exchange_codes (
  code_hash  TEXT PRIMARY KEY,
  -- JSON NewSession: { uid, login, avatarUrl, roles } — unsigned, not a credential.
  claims     TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Sweeping expired codes is by timestamp. Expiry is enforced in the query, so
-- a missed sweep costs rows, never correctness.
CREATE INDEX IF NOT EXISTS idx_auth_exchange_codes_expires
  ON auth_exchange_codes(expires_at);
