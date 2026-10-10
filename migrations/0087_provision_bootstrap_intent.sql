-- #358 correction: the backend execution request and the MCP bootstrap plan
-- have different identities. Keep both so an interrupted bootstrap can join
-- only an identical repo/template/name/options plan, while /v1/provision
-- independently binds its own validated request before admission is claimed.
ALTER TABLE provision_operations ADD COLUMN bootstrap_intent_hash TEXT NOT NULL DEFAULT '';
