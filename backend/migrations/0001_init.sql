-- Migration number: 0001 	 init
CREATE TABLE users (
  handle TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  total_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE usage_days (
  handle TEXT NOT NULL REFERENCES users(handle),
  day TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (handle, day)
);

CREATE INDEX idx_usage_days_day ON usage_days(day);
CREATE INDEX idx_users_total_seconds ON users(total_seconds DESC);
