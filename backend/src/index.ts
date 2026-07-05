import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import type { User } from "./db";
import { isError, type HubCore } from "./hub";
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

export type HubStub = Pick<
  HubCore,
  "register" | "heartbeat" | "status" | "leaderboard" | "deleteUser"
>;
type HubNamespace = { idFromName(name: string): unknown; get(id: unknown): HubStub };

type AppEnv = {
  Bindings: {
    HUB: HubNamespace;
    RATE_LIMITER?: RateLimiter;
    GET_LIMITER?: RateLimiter;
  };
};

const ACTIVE_WINDOW_SECONDS = 300;
const MAX_BODY_BYTES = 4096;

const hub = (c: Context<AppEnv>): HubStub => c.env.HUB.get(c.env.HUB.idFromName("hub"));

const clientIp = (c: Context<AppEnv>): string => c.req.header("cf-connecting-ip") ?? "unknown";

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

const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json({ error: "body too large" }, 413),
});

app.use("/v1/*", async (c, next) => {
  const isWrite = WRITE_METHODS.has(c.req.method);
  const limiter = isWrite ? c.env.RATE_LIMITER : c.env.GET_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: clientIp(c) });
    if (!success) {
      return c.json({ error: "rate limited; slow down" }, 429);
    }
  }
  return isWrite ? limitBody(c, next) : next();
});

app.get("/", (c) => c.json({ ok: true, service: "friends.nvim" }));

app.put(
  "/v1/users/:handle",
  zValidator("param", HandleParam, onInvalid),
  zValidator("json", RegisterBody, onInvalid),
  async (c) => {
    const { handle } = c.req.valid("param");
    const { token, display_name } = c.req.valid("json");
    const result = await hub(c).register({ handle, token, display_name, ip: clientIp(c) });
    if (isError(result)) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(userJson(result.user, result.at));
  },
);

app.post(
  "/v1/users/:handle/heartbeat",
  zValidator("param", HandleParam, onInvalid),
  zValidator("json", HeartbeatBody, onInvalid),
  async (c) => {
    const { handle } = c.req.valid("param");
    const { token, seconds, handles } = c.req.valid("json");
    const result = await hub(c).heartbeat({ handle, token, seconds, handles });
    if (isError(result)) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json({
      ...userJson(result.user, result.at),
      ...(result.users && { users: result.users.map((user) => userJson(user, result.at)) }),
    });
  },
);

app.delete(
  "/v1/users/:handle",
  zValidator("param", HandleParam, onInvalid),
  zValidator("json", DeleteBody, onInvalid),
  async (c) => {
    const { handle } = c.req.valid("param");
    const { token } = c.req.valid("json");
    const result = await hub(c).deleteUser({ handle, token });
    if (isError(result)) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json({ ok: true });
  },
);

app.get("/v1/users", zValidator("query", StatusQuery, onInvalid), async (c) => {
  const { handles } = c.req.valid("query");
  const { users, at } = await hub(c).status(handles);
  return c.json({ users: users.map((user) => userJson(user, at)) });
});

app.get("/v1/leaderboard", zValidator("query", LeaderboardQuery, onInvalid), async (c) => {
  const { period, limit, handles } = c.req.valid("query");
  const { entries, at } = await hub(c).leaderboard({ period, limit, handles });
  return c.json({
    period,
    entries: entries.map(({ seconds, ...user }, i) => ({
      rank: i + 1,
      seconds,
      ...userJson(user, at),
    })),
  });
});

export default app;
