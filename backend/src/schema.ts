import { z } from "zod";

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const TOKEN_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export const MAX_HEARTBEAT_SECONDS = 300;
export const MAX_STATUS_HANDLES = 64;
export const MAX_LEADERBOARD_LIMIT = 100;

export const Handle = z.string().regex(HANDLE_RE);
export const Token = z.string().regex(TOKEN_RE);

const handleList = (max: number) =>
  z
    .string()
    .transform((raw) => raw.split(",").filter((h) => h.length > 0))
    .pipe(z.array(z.string()).min(1).max(max));

export const HandleParam = z.object({ handle: Handle });

export const RegisterBody = z.object({
  token: Token,
  display_name: z.string().max(64).optional(),
});

export const HeartbeatBody = z.object({
  token: Token,
  seconds: z.number().int().min(1).max(MAX_HEARTBEAT_SECONDS),
});

export const StatusQuery = z.object({
  handles: handleList(MAX_STATUS_HANDLES),
});

export const Period = z.enum(["all", "today", "week"]);

export const LeaderboardQuery = z.object({
  period: Period.default("all"),
  limit: z.coerce.number().int().min(1).max(MAX_LEADERBOARD_LIMIT).default(20),
  handles: handleList(MAX_STATUS_HANDLES).optional(),
});

export type RegisterBody = z.infer<typeof RegisterBody>;
export type HeartbeatBody = z.infer<typeof HeartbeatBody>;
export type StatusQuery = z.infer<typeof StatusQuery>;
export type LeaderboardQuery = z.infer<typeof LeaderboardQuery>;
export type Period = z.infer<typeof Period>;
