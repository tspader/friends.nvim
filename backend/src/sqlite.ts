import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journal } from "./hub";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

class Stmt {
  constructor(
    private db: Database,
    private sql: string,
    private params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    return this.db.query(this.sql).get(...(this.params as never[])) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql).all(...(this.params as never[])) as T[] };
  }

  async run(): Promise<unknown> {
    return this.db.query(this.sql).run(...(this.params as never[]));
  }
}

export function createLocalJournal(): Journal {
  const db = new Database(":memory:");
  return {
    exec: (sql: string, ...params: (string | number | null)[]) => {
      const rows = db.query(sql).all(...(params as never[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}

export function createLocalDb(): D1Database {
  const db = new Database(":memory:");
  const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of migrations) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  const shim = {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => {
      const results = [];
      for (const stmt of stmts) {
        results.push(await stmt.run());
      }
      return results;
    },
  };
  return shim as unknown as D1Database;
}
