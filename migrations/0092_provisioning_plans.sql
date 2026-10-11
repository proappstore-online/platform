-- #367: provisioning plans the Creator Console previews and then confirms.
-- A row holds the plan exactly as it was shown (plan_json, computed by the MCP
-- worker's read-only planProvision) and the input that produced it, bound to
-- the session user who asked. Confirming re-plans and refuses a plan whose
-- bound facts changed; nothing in the browser is trusted to describe the plan.
--   expires_at       a plan not executed by then must be previewed again
--   executing_until  the single in-flight confirmation's lease: concurrent
--                    confirms join it instead of starting a second execution
--   receipt_id       the durable provisioning receipt (#358) it executed under
CREATE TABLE IF NOT EXISTS provisioning_plans (
  plan_id         TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  app_id          TEXT NOT NULL,
  input_json      TEXT NOT NULL,
  plan_json       TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  executing_until INTEGER,
  receipt_id      TEXT,
  confirmed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_provisioning_plans_user ON provisioning_plans (user_id, created_at);
