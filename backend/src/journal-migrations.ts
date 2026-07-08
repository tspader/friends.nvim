import m0001 from "../journal-migrations/0001_pending.sql";
import m0002 from "../journal-migrations/0002_counters.sql";
import type { Journal } from "./hub";

// Append only!
const MIGRATIONS = [m0001, m0002];

const baseline = (journal: Journal): number => {
  const row = journal
    .exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending'")
    .toArray()[0];
  if (!row) return 0;
  return String(row.sql).includes("day_counters") ? 2 : 1;
};

export const migrateJournal = (journal: Journal, upTo = MIGRATIONS.length): void => {
  journal.exec("CREATE TABLE IF NOT EXISTS journal_migrations (id INTEGER PRIMARY KEY)");
  const applied = journal
    .exec("SELECT COALESCE(MAX(id), 0) AS version FROM journal_migrations")
    .toArray()[0]?.version as number;
  let version = applied > 0 ? applied : baseline(journal);
  if (version > applied) {
    journal.exec("INSERT INTO journal_migrations (id) VALUES (?1)", version);
  }
  for (; version < upTo; version++) {
    for (const statement of MIGRATIONS[version]!.split(";")) {
      if (statement.trim().length > 0) journal.exec(statement);
    }
    journal.exec("INSERT INTO journal_migrations (id) VALUES (?1)", version + 1);
  }
};
