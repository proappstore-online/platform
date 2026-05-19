-- Track app submissions awaiting admin review.
-- Devs POST a submission with the desired app id + metadata; admins approve
-- (which triggers the existing provisioning flow) or reject.
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,                                       -- uuid
  app_id TEXT NOT NULL,                                      -- desired app id, e.g. "kanban"
  creator_id TEXT NOT NULL,                                  -- gh:<id>, FK loosely to users
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','published')),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  icon TEXT,
  icon_bg TEXT,
  pro_features TEXT,                                          -- JSON array string
  suggested_monthly_price_cents INTEGER,
  repo_url TEXT,
  reviewer_id TEXT,
  rejection_reason TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX idx_submissions_creator ON submissions(creator_id);
CREATE INDEX idx_submissions_status ON submissions(status);
