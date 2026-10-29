-- "I'm building this" claims on the storefront's App ideas page (proappstore.online/ideas).
--
-- One row per (idea, user): a signed-in user saying they are building that idea. The idea id is the
-- storefront's own slug for the idea (ideas live in the storefront's static data, not in D1), so there
-- is no foreign key. created_at is epoch seconds and is refreshed when a user re-claims; only claims
-- from the last 90 days are counted, so an abandoned claim stops looking like active work.
-- Same contract as FreeAppStore's idea_builders table.
CREATE TABLE IF NOT EXISTS idea_builders (
  idea_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (idea_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_idea_builders_user ON idea_builders (user_id, created_at);

-- Fixed-window limiter on NEW claims per user (10 per 60 s). Kept apart from idea_builders because a
-- claim-then-release loop leaves no rows there to count; one row per user, rolled by an atomic upsert.
CREATE TABLE IF NOT EXISTS idea_builder_rate (
  user_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
