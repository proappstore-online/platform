-- Passkey management (#700): a person lists, names and removes their own
-- passkeys. `name` is set at registration (from the request or the user agent)
-- and renamable; NULL on credentials registered before #700. `transports` is
-- the JSON array the browser reported (getTransports()), a hint for telling
-- devices apart; NULL when none was sent.
ALTER TABLE passkey_credentials ADD COLUMN name TEXT;
ALTER TABLE passkey_credentials ADD COLUMN transports TEXT;
