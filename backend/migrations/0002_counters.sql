-- Migration number: 0002 	 counters
ALTER TABLE users ADD COLUMN counters TEXT NOT NULL DEFAULT '{}';
ALTER TABLE usage_days ADD COLUMN counters TEXT NOT NULL DEFAULT '{}';
