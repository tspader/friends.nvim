import { Hono } from "hono";

type Env = { Bindings: { DB: D1Database } };

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const TOKEN_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const ACTIVE_WINDOW_SECONDS = 120;
const MAX_HEARTBEAT_SECONDS = 300;
const MIN_HEARTBEAT_GAP_SECONDS = 15;
const MAX_STATUS_HANDLES = 64;
const MAX_LEADERBOARD_LIMIT = 100;

const now = () => Math.floor(Date.now() / 1000);
const utcDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

type UserRow = {
  handle: string;
  token?: string;
  display_name: string | null;
  total_seconds: number;
  last_seen_at: number | null;
};

const userJson = (row: UserRow, at: number) => ({
  handle: row.handle,
  display_name: row.display_name,
  total_seconds: row.total_seconds,
  last_seen_at: row.last_seen_at,
  active: row.last_seen_at !== null && at - row.last_seen_at <= ACTIVE_WINDOW_SECONDS,
});

const app = new Hono<Env>({ strict: false }).basePath("/api");

app.get("/", (c) => c.json({ ok: true, service: "friends.nvim" }));

app.put("/v1/users/:handle", async (c) => {
  const handle = c.req.param("handle");
  if (!HANDLE_RE.test(handle)) {
    return c.json({ error: "invalid handle" }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const token = body.token;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return c.json({ error: "invalid token" }, 400);
  }
  const displayName = body.display_name;
  if (displayName !== undefined && (typeof displayName !== "string" || displayName.length > 64)) {
    return c.json({ error: "invalid display_name" }, 400);
  }

  const at = now();
  const existing = await c.env.DB.prepare("SELECT token FROM users WHERE handle = ?1")
    .bind(handle)
    .first<{ token: string }>();
  if (existing && existing.token !== token) {
    return c.json({ error: "handle taken" }, 409);
  }
  if (!existing) {
    await c.env.DB.prepare("INSERT INTO users (handle, token, created_at) VALUES (?1, ?2, ?3)")
      .bind(handle, token, at)
      .run();
  }
  if (displayName !== undefined) {
    await c.env.DB.prepare("UPDATE users SET display_name = ?2 WHERE handle = ?1")
      .bind(handle, displayName)
      .run();
  }

  const row = await c.env.DB.prepare(
    "SELECT handle, display_name, total_seconds, last_seen_at FROM users WHERE handle = ?1",
  )
    .bind(handle)
    .first<UserRow>();
  return c.json(userJson(row!, at));
});

app.post("/v1/users/:handle/heartbeat", async (c) => {
  const handle = c.req.param("handle");
  if (!HANDLE_RE.test(handle)) {
    return c.json({ error: "invalid handle" }, 400);
  }
  const body = await c.req.json().catch(() => null);
  const token = body?.token;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return c.json({ error: "invalid token" }, 400);
  }
  const seconds = body?.seconds;
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_HEARTBEAT_SECONDS) {
    return c.json({ error: "seconds must be an integer in [1, 300]" }, 400);
  }

  const at = now();
  const existing = await c.env.DB.prepare(
    "SELECT token, last_seen_at FROM users WHERE handle = ?1",
  )
    .bind(handle)
    .first<{ token: string; last_seen_at: number | null }>();
  if (existing && existing.token !== token) {
    return c.json({ error: "handle taken" }, 403);
  }

  // Credit at most wall-clock time since the last heartbeat, so hours can't
  // accrue faster than real time (and two machines on one handle don't
  // double-count).
  let credited = seconds;
  if (existing && existing.last_seen_at !== null) {
    const gap = at - existing.last_seen_at;
    if (gap < MIN_HEARTBEAT_GAP_SECONDS) {
      return c.json({ error: "too many heartbeats; wait a moment" }, 429);
    }
    credited = Math.min(seconds, gap);
  }

  const statements = [
    c.env.DB.prepare(
      "UPDATE users SET total_seconds = total_seconds + ?2, last_seen_at = ?3 WHERE handle = ?1",
    ).bind(handle, credited, at),
    c.env.DB.prepare(
      "INSERT INTO usage_days (handle, day, seconds) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(handle, day) DO UPDATE SET seconds = seconds + excluded.seconds",
    ).bind(handle, utcDay(at), credited),
  ];
  if (!existing) {
    statements.unshift(
      c.env.DB.prepare("INSERT INTO users (handle, token, created_at) VALUES (?1, ?2, ?3)").bind(
        handle,
        token,
        at,
      ),
    );
  }
  await c.env.DB.batch(statements);

  const row = await c.env.DB.prepare(
    "SELECT handle, display_name, total_seconds, last_seen_at FROM users WHERE handle = ?1",
  )
    .bind(handle)
    .first<UserRow>();
  return c.json(userJson(row!, at));
});

app.get("/v1/users", async (c) => {
  const param = c.req.query("handles") ?? "";
  const handles = param.split(",").filter((h) => h.length > 0);
  if (handles.length === 0 || handles.length > MAX_STATUS_HANDLES) {
    return c.json({ error: `handles must list 1-${MAX_STATUS_HANDLES} handles` }, 400);
  }

  const at = now();
  const placeholders = handles.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await c.env.DB.prepare(
    "SELECT handle, display_name, total_seconds, last_seen_at FROM users " +
      `WHERE handle IN (${placeholders})`,
  )
    .bind(...handles)
    .all<UserRow>();

  const byHandle = new Map(results.map((r) => [r.handle, r]));
  const users = handles.flatMap((h) => {
    const row = byHandle.get(h);
    return row ? [userJson(row, at)] : [];
  });
  return c.json({ users });
});

app.get("/v1/leaderboard", async (c) => {
  const period = c.req.query("period") ?? "all";
  if (period !== "all" && period !== "today" && period !== "week") {
    return c.json({ error: "period must be all, today, or week" }, 400);
  }
  const limit = Number(c.req.query("limit") ?? 20);
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LEADERBOARD_LIMIT) {
    return c.json({ error: `limit must be an integer in [1, ${MAX_LEADERBOARD_LIMIT}]` }, 400);
  }
  const handlesParam = c.req.query("handles");
  const handles = handlesParam ? handlesParam.split(",").filter((h) => h.length > 0) : null;
  if (handles && handles.length > MAX_STATUS_HANDLES) {
    return c.json({ error: `handles must list at most ${MAX_STATUS_HANDLES} handles` }, 400);
  }

  const at = now();
  const bind: (string | number)[] = [];
  let sql: string;
  if (period === "all") {
    sql =
      "SELECT handle, display_name, total_seconds, last_seen_at, total_seconds AS seconds FROM users";
  } else {
    const since = period === "today" ? utcDay(at) : utcDay(at - 6 * 86400);
    bind.push(since);
    sql =
      "SELECT u.handle, u.display_name, u.total_seconds, u.last_seen_at, SUM(d.seconds) AS seconds " +
      "FROM usage_days d JOIN users u ON u.handle = d.handle " +
      `WHERE d.day >= ?${bind.length} `;
  }
  if (handles) {
    const placeholders = handles.map((h) => {
      bind.push(h);
      return `?${bind.length}`;
    });
    sql += `${period === "all" ? " WHERE" : "AND"} ${period === "all" ? "handle" : "u.handle"} IN (${placeholders.join(",")}) `;
  }
  if (period !== "all") {
    sql += "GROUP BY u.handle ";
  }
  bind.push(limit);
  sql += ` ORDER BY seconds DESC, ${period === "all" ? "handle" : "u.handle"} ASC LIMIT ?${bind.length}`;

  const { results } = await c.env.DB.prepare(sql)
    .bind(...bind)
    .all<UserRow & { seconds: number }>();
  const entries = results.map((row, i) => ({
    rank: i + 1,
    seconds: row.seconds,
    ...userJson(row, at),
  }));
  return c.json({ period, entries });
});

export default app;
