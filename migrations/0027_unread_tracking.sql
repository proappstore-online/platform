-- Track when each user last read messages in an engagement.
-- Used to compute unread counts for notification badges.

CREATE TABLE IF NOT EXISTS engagement_reads (
  engagement_id TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  last_read_at  INTEGER NOT NULL,
  PRIMARY KEY (engagement_id, user_id)
);
