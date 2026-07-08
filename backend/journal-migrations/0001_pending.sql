CREATE TABLE IF NOT EXISTS pending (
  handle TEXT NOT NULL,
  day TEXT NOT NULL,
  day_seconds INTEGER NOT NULL,
  total_seconds INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (handle, day)
);
