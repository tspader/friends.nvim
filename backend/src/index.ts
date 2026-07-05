import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { createDb, type User } from "./db";
import {
  DeleteBody,
  HandleParam,
  HeartbeatBody,
  LeaderboardQuery,
  MAX_HEARTBEAT_SECONDS,
  MAX_LEADERBOARD_LIMIT,
  MAX_STATUS_HANDLES,
  RegisterBody,
  StatusQuery,
} from "./schema";

type RateLimiter = { limit: (opts: { key: string }) => Promise<{ success: boolean }> };

type AppEnv = { Bindings: { DB: D1Database; RATE_LIMITER?: RateLimiter } };

const ACTIVE_WINDOW_SECONDS = 120;
const MIN_HEARTBEAT_GAP_SECONDS = 15;

const now = () => Math.floor(Date.now() / 1000);

const userJson = (user: User, at: number) => ({
  ...user,
  active: user.last_seen_at !== null && at - user.last_seen_at <= ACTIVE_WINDOW_SECONDS,
});

const MESSAGES: Record<string, string> = {
  handle: "invalid handle",
  token: "invalid token",
  display_name: "invalid display_name",
  seconds: `seconds must be an integer in [1, ${MAX_HEARTBEAT_SECONDS}]`,
  period: "period must be all, today, or week",
  handles: `handles must list 1-${MAX_STATUS_HANDLES} handles`,
  limit: `limit must be an integer in [1, ${MAX_LEADERBOARD_LIMIT}]`,
};

const onInvalid = (
  result:
    | { success: true }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }> } },
  c: Context,
) => {
  if (!result.success) {
    const field = result.error.issues[0]?.path.at(-1)?.toString() ?? "";
    return c.json({ error: MESSAGES[field] ?? "invalid request" }, 400);
  }
};

const app = new Hono<AppEnv>({ strict: false }).basePath("/api");

const WRITE_METHODS = new Set(["PUT", "POST", "DELETE"]);

app.use("/v1/*", async (c, next) => {
  const limiter = c.env.RATE_LIMITER;
  if (limiter && WRITE_METHODS.has(c.req.method)) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await limiter.limit({ key: ip });
    if (!success) {
      return c.json({ error: "rate limited; slow down" }, 429);
    }
  }
  return next();
});

app.get("/", (c) => c.json({ ok: true, service: "friends.nvim" }));

app.put(
  "/v1/users/:handle",
  zValidator("param", HandleParam, onInvalid),
  zValidator("json", RegisterBody, onInvalid),
  async (c) => {
    const { handle } = c.req.valid("param");
    const { token, display_name } = c.req.valid("json");
    const db = createDb(c.env.DB);

    const at = now();
    await db.createUser({ handle, token, at });
    const owner = await db.owner(handle);
    if (owner!.token !== token) {
      return c.json({ error: "handle taken" }, 409);
    }
    if (display_name !== undefined) {
      await db.setDisplayName(handle, display_name);
    }

    const user = await db.user(handle);
    return c.json(userJson(user!, at));
  },
);

app.post(
  "/v1/users/:handle/heartbeat",
  zValidator("param", HandleParam, onInvalid),
  zValidator("json", HeartbeatBody, onInvalid),
  async (c) => {
    const { handle } = c.req.valid("param");
    const { token, seconds } = c.req.valid("json");
    const db = createDb(c.env.DB);

    const at = now();
    const owner = await db.owner(handle);
    if (owner && owner.token !== token) {
      return c.json({ error: "handle taken" }, 403);
    }

    // Credit at most wall-clock time since the last heartbeat, so hours can't
    // accrue faster than real time (and two machines on one handle don't
    // double-count).
    let credited = seconds;
    if (owner && owner.last_seen_at !== null) {
      const gap = at - owner.last_seen_at;
      if (gap < MIN_HEARTBEAT_GAP_SECONDS) {
        return c.json({ error: "too many heartbeats; wait a moment" }, 429);
      }
      credited = Math.min(seconds, gap);
    }

    await db.creditUsage({ handle, token, seconds: credited, at, isNew: !owner });

    const user = await db.user(handle);
    return c.json(userJson(user!, at));
  },
);

app.delete(
  "/v1/users/:handle",
  zValidator("param", HandleParam, onInvalid),
  zValidator("json", DeleteBody, onInvalid),
  async (c) => {
    const { handle } = c.req.valid("param");
    const { token } = c.req.valid("json");
    const db = createDb(c.env.DB);

    const owner = await db.owner(handle);
    if (!owner) {
      return c.json({ error: "not found" }, 404);
    }
    if (owner.token !== token) {
      return c.json({ error: "handle taken" }, 403);
    }
    await db.deleteUser(handle);
    return c.json({ ok: true });
  },
);

app.get("/v1/users", zValidator("query", StatusQuery, onInvalid), async (c) => {
  const { handles } = c.req.valid("query");
  const db = createDb(c.env.DB);

  const at = now();
  const rows = await db.users(handles);
  const byHandle = new Map(rows.map((row) => [row.handle, row]));
  const users = handles.flatMap((handle) => {
    const row = byHandle.get(handle);
    return row ? [userJson(row, at)] : [];
  });
  return c.json({ users });
});

app.get("/v1/leaderboard", zValidator("query", LeaderboardQuery, onInvalid), async (c) => {
  const { period, limit, handles } = c.req.valid("query");
  const db = createDb(c.env.DB);

  const at = now();
  const rows = await db.leaderboard({ period, limit, at, handles });
  const entries = rows.map((row, i) => ({
    rank: i + 1,
    seconds: row.seconds,
    ...userJson(row, at),
  }));
  return c.json({ period, entries });
});

export default app;
