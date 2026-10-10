-- #355 safety rollback. 0081 was deployed with an unsafe broker that could
-- encrypt broadly usable PAS sessions. The endpoint is now disabled; purge
-- its short-lived request/result records rather than retain replay material.
DELETE FROM mcp_remote_auth_requests;
