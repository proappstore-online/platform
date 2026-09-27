-- Operator gate (#229, part of #228). Declared in an app's mcp.json
-- (`operator: { prefix, role }`), validated and replaced with its tools at
-- registration, read by the host on every request: paths under `path_prefix`
-- are served only to a signed-in user holding app role `role_name`.
CREATE TABLE IF NOT EXISTS app_operator_gate (
  app_id      TEXT PRIMARY KEY,
  path_prefix TEXT NOT NULL,     -- e.g. /admin; matches /admin and /admin/*
  role_name   TEXT NOT NULL,     -- an app role (app_roles.role_name), never 'member'
  created_at  INTEGER NOT NULL
);
