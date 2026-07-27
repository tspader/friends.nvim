import { z } from "zod";
import { COUNTER_METRIC_NAMES } from "./metrics";

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const TOKEN_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export const MAX_HEARTBEAT_SECONDS = 300;
export const MAX_STATUS_HANDLES = 64;
export const MAX_LEADERBOARD_LIMIT = 100;

export const Handle = z.string().regex(HANDLE_RE);
export const Token = z.string().regex(TOKEN_RE);

export const DisplayName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^\P{C}+$/u);

const handleList = (max: number) =>
  z
    .string()
    .transform((raw) => raw.split(",").filter((h) => h.length > 0))
    .pipe(z.array(z.string()).min(1).max(max));

export const HandleParam = z.object({ handle: Handle });

export const RegisterBody = z.object({
  token: Token,
  display_name: DisplayName.optional(),
});

const CounterName = z.enum(COUNTER_METRIC_NAMES as [string, ...string[]]);

export const HeartbeatBody = z.object({
  token: Token,
  seconds: z.number().int().min(1).max(MAX_HEARTBEAT_SECONDS),
  counters: z.partialRecord(CounterName, z.number().int().min(0)).optional(),
  handles: z.array(Handle).min(1).max(MAX_STATUS_HANDLES).optional(),
});

export const DeleteBody = z.object({ token: Token });

export const PingMessage = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\P{C}+$/u);

export const PingBody = z.object({
  token: Token,
  to: Handle,
  message: PingMessage.optional(),
});

export const PingsPollBody = z.object({ token: Token });

export const StatusQuery = z.object({
  handles: handleList(MAX_STATUS_HANDLES),
});

export const Period = z.enum(["all", "today", "week"]);

export const Metric = z.enum(["active_time", ...COUNTER_METRIC_NAMES] as [string, ...string[]]);

export const LeaderboardQuery = z.object({
  period: Period.default("all"),
  metric: Metric.default("active_time"),
  limit: z.coerce.number().int().min(1).max(MAX_LEADERBOARD_LIMIT).default(20),
  handles: handleList(MAX_STATUS_HANDLES).optional(),
});

export type RegisterBody = z.infer<typeof RegisterBody>;
export type HeartbeatBody = z.infer<typeof HeartbeatBody>;
export type StatusQuery = z.infer<typeof StatusQuery>;
export type LeaderboardQuery = z.infer<typeof LeaderboardQuery>;
export type Period = z.infer<typeof Period>;
export type Metric = z.infer<typeof Metric>;
export type PingBody = z.infer<typeof PingBody>;
export type PingsPollBody = z.infer<typeof PingsPollBody>;
