export type User = {
  handle: string;
  display_name: string | null;
  total_seconds: number;
  last_seen_at: number | null;
};

export type UserRow = User & { token: string };

export type UsageDayRow = { handle: string; day: string; seconds: number };

export const utcDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

const chunked = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

export const createDb = (d1: D1Database) => ({
  allUsers: async (): Promise<UserRow[]> => {
    const { results } = await d1
      .prepare("SELECT handle, token, display_name, total_seconds, last_seen_at FROM users")
      .all<UserRow>();
    return results;
  },

  usageDaysSince: async (day: string): Promise<UsageDayRow[]> => {
    const { results } = await d1
      .prepare("SELECT handle, day, seconds FROM usage_days WHERE day >= ?1")
      .bind(day)
      .all<UsageDayRow>();
    return results;
  },

  insertUser: async (user: {
    handle: string;
    token: string;
    display_name: string | null;
    at: number;
  }): Promise<void> => {
    await d1
      .prepare(
        "INSERT INTO users (handle, token, display_name, created_at) VALUES (?1, ?2, ?3, ?4) " +
          "ON CONFLICT(handle) DO NOTHING",
      )
      .bind(user.handle, user.token, user.display_name, user.at)
      .run();
  },

  setDisplayName: async (handle: string, displayName: string): Promise<void> => {
    await d1
      .prepare("UPDATE users SET display_name = ?2 WHERE handle = ?1")
      .bind(handle, displayName)
      .run();
  },

  deleteUser: async (handle: string): Promise<void> => {
    await d1.batch([
      d1.prepare("DELETE FROM usage_days WHERE handle = ?1").bind(handle),
      d1.prepare("DELETE FROM users WHERE handle = ?1").bind(handle),
    ]);
  },

  flushUsage: async (input: {
    users: { handle: string; total_seconds: number; last_seen_at: number | null }[];
    usage: UsageDayRow[];
    chunk: number;
  }): Promise<void> => {
    const statements = [
      ...input.users.map((row) =>
        d1
          .prepare("UPDATE users SET total_seconds = ?2, last_seen_at = ?3 WHERE handle = ?1")
          .bind(row.handle, row.total_seconds, row.last_seen_at),
      ),
      ...input.usage.map((row) =>
        d1
          .prepare(
            "INSERT INTO usage_days (handle, day, seconds) VALUES (?1, ?2, ?3) " +
              "ON CONFLICT(handle, day) DO UPDATE SET seconds = excluded.seconds",
          )
          .bind(row.handle, row.day, row.seconds),
      ),
    ];
    for (const batch of chunked(statements, input.chunk)) {
      await d1.batch(batch);
    }
  },

  pruneUsageDays: async (beforeDay: string): Promise<void> => {
    await d1.prepare("DELETE FROM usage_days WHERE day < ?1").bind(beforeDay).run();
  },
});

export type Db = ReturnType<typeof createDb>;
