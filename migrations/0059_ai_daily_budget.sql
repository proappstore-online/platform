-- Workers AI daily budget (#218, a child of #27). Weighted units a user has
-- spent on /v1/ai/* per UTC day; charged atomically before each model call.
CREATE TABLE IF NOT EXISTS ai_daily_budget (
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,           -- UTC YYYY-MM-DD
  units_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
