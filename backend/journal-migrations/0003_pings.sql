CREATE TABLE IF NOT EXISTS pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_handle TEXT NOT NULL,
  from_handle TEXT NOT NULL,
  message TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pings_to_handle ON pings (to_handle);
