import type { Period } from "./schema";

export type User = {
  handle: string;
  display_name: string | null;
  total_seconds: number;
  last_seen_at: number | null;
};

export type Owner = {
  token: string;
  last_seen_at: number | null;
};

export type LeaderboardRow = User & { seconds: number };

const USER_COLUMNS = "handle, display_name, total_seconds, last_seen_at";

export const utcDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

export const createDb = (d1: D1Database) => ({
  owner: (handle: string): Promise<Owner | null> =>
    d1.prepare("SELECT token, last_seen_at FROM users WHERE handle = ?1").bind(handle).first<Owner>(),

  user: (handle: string): Promise<User | null> =>
    d1.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE handle = ?1`).bind(handle).first<User>(),

  users: async (handles: string[]): Promise<User[]> => {
    const placeholders = handles.map((_, i) => `?${i + 1}`).join(",");
    const { results } = await d1
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE handle IN (${placeholders})`)
      .bind(...handles)
      .all<User>();
    return results;
  },

  createUser: async (user: { handle: string; token: string; at: number }): Promise<void> => {
    await d1
      .prepare(
        "INSERT INTO users (handle, token, created_at) VALUES (?1, ?2, ?3) " +
          "ON CONFLICT(handle) DO NOTHING",
      )
      .bind(user.handle, user.token, user.at)
      .run();
  },

  deleteUser: async (handle: string): Promise<void> => {
    await d1.batch([
      d1.prepare("DELETE FROM usage_days WHERE handle = ?1").bind(handle),
      d1.prepare("DELETE FROM users WHERE handle = ?1").bind(handle),
    ]);
  },

  setDisplayName: async (handle: string, displayName: string): Promise<void> => {
    await d1
      .prepare("UPDATE users SET display_name = ?2 WHERE handle = ?1")
      .bind(handle, displayName)
      .run();
  },

  creditUsage: async (usage: {
    handle: string;
    token: string;
    seconds: number;
    at: number;
    isNew: boolean;
  }): Promise<void> => {
    const statements = [
      d1
        .prepare("UPDATE users SET total_seconds = total_seconds + ?2, last_seen_at = ?3 WHERE handle = ?1")
        .bind(usage.handle, usage.seconds, usage.at),
      d1
        .prepare(
          "INSERT INTO usage_days (handle, day, seconds) VALUES (?1, ?2, ?3) " +
            "ON CONFLICT(handle, day) DO UPDATE SET seconds = seconds + excluded.seconds",
        )
        .bind(usage.handle, utcDay(usage.at), usage.seconds),
    ];
    if (usage.isNew) {
      statements.unshift(
        d1
          .prepare(
            "INSERT INTO users (handle, token, created_at) VALUES (?1, ?2, ?3) " +
              "ON CONFLICT(handle) DO NOTHING",
          )
          .bind(usage.handle, usage.token, usage.at),
      );
    }
    await d1.batch(statements);
  },

  leaderboard: async (query: {
    period: Period;
    limit: number;
    at: number;
    handles?: string[];
  }): Promise<LeaderboardRow[]> => {
    const isAll = query.period === "all";
    const from = isAll
      ? "FROM users u"
      : "FROM usage_days d JOIN users u ON u.handle = d.handle";
    const secondsExpr = isAll ? "u.total_seconds" : "SUM(d.seconds)";

    const bind: (string | number)[] = [];
    const conditions: string[] = [];
    if (!isAll) {
      const since = query.period === "today" ? utcDay(query.at) : utcDay(query.at - 6 * 86400);
      bind.push(since);
      conditions.push(`d.day >= ?${bind.length}`);
    }
    if (query.handles) {
      const placeholders = query.handles.map((handle) => {
        bind.push(handle);
        return `?${bind.length}`;
      });
      conditions.push(`u.handle IN (${placeholders.join(",")})`);
    }

    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const groupBy = isAll ? "" : " GROUP BY u.handle";
    bind.push(query.limit);
    const sql =
      `SELECT u.handle, u.display_name, u.total_seconds, u.last_seen_at, ${secondsExpr} AS seconds ` +
      `${from}${where}${groupBy} ORDER BY seconds DESC, u.handle ASC LIMIT ?${bind.length}`;

    const { results } = await d1
      .prepare(sql)
      .bind(...bind)
      .all<LeaderboardRow>();
    return results;
  },
});

export type Db = ReturnType<typeof createDb>;
