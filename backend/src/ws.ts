// Everything the websocket path does that does not need the Durable Object
// runtime. Kept out of do.ts so it can be tested without cloudflare:workers.
import { isError, userJson, type HubCore } from "./hub";
import { MAX_BODY_BYTES, WsHeartbeatBody } from "./schema";

// The subset of WebSocket that both workerd and Bun's ServerWebSocket satisfy.
export type WsLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
};

export const WS_OPEN = 1;

// Frames per socket per window. A heartbeat is one frame every two minutes, so
// this is orders of magnitude above any honest client.
export const MAX_WS_MESSAGES_PER_WINDOW = 60;
export const WS_LIMIT_WINDOW_MS = 60_000;

export const CLOSE_POLICY_VIOLATION = 1008;

export type Attachment = { handle: string; token: string };

export const helloFrame = (handle: string): string =>
  JSON.stringify({ type: "hello", handle });

export const pingFrame = (from: string, message: string | null, at: number): string =>
  JSON.stringify({ type: "ping", from, message, at });

// close() only accepts 1000 or 3000-4999. A peer that sends an empty close
// frame surfaces as 1005, and echoing that back throws.
export const safeCloseCode = (code: number): number =>
  code >= 3000 && code <= 4999 ? code : 1000;

// Fans a frame out to a recipient's sockets. Skipping sockets that are not
// OPEN keeps us from reporting delivery on one we already know is going away.
// It does NOT catch a peer that died without a close handshake: that socket
// still reports OPEN, so a live ping can still be lost. The durable queue is
// only skipped when this returns true, so that window is the residual risk.
export const deliverPing = (sockets: WsLike[], frame: string): boolean => {
  let delivered = false;
  for (const ws of sockets) {
    if (ws.readyState !== WS_OPEN) {
      continue;
    }
    try {
      ws.send(frame);
      delivered = true;
    } catch {
      // socket race; fall through to the durable queue
    }
  }
  return delivered;
};

export type UpgradeAuth = { handle: string; token: string };
export type UpgradeRejection = { status: 401; message: string };

export const isRejection = (result: UpgradeAuth | UpgradeRejection): result is UpgradeRejection =>
  "status" in result;

export const authorizeUpgrade = async (
  core: Pick<HubCore, "authenticate">,
  request: Request,
): Promise<UpgradeAuth | UpgradeRejection> => {
  const handle = request.headers.get("X-Friends-Handle");
  const token = request.headers.get("X-Friends-Token");
  if (!handle || !token) {
    return { status: 401, message: "missing credentials" };
  }
  const auth = await core.authenticate(handle, token);
  if (isError(auth)) {
    return { status: 401, message: "unauthorized" };
  }
  return { handle, token };
};

// Per-socket frame budget. Messages arriving after the upgrade never pass
// through the /v1/* rate limiter, so without this a single connection can
// spin the shared hub object for free.
export type WsLimiter = {
  allow(ws: WsLike): boolean;
  forget(ws: WsLike): void;
};

export const createWsLimiter = (
  max = MAX_WS_MESSAGES_PER_WINDOW,
  windowMs = WS_LIMIT_WINDOW_MS,
): WsLimiter => {
  const seen = new Map<WsLike, { count: number; windowStart: number }>();
  return {
    allow(ws) {
      const now = Date.now();
      const state = seen.get(ws);
      if (!state || now - state.windowStart >= windowMs) {
        seen.set(ws, { count: 1, windowStart: now });
        return true;
      }
      state.count += 1;
      return state.count <= max;
    },
    forget(ws) {
      seen.delete(ws);
    },
  };
};

export const handleWsMessage = async (
  core: Pick<HubCore, "heartbeat">,
  attachment: Attachment,
  message: string | ArrayBuffer,
  ws: WsLike,
  limiter?: WsLimiter,
): Promise<void> => {
  if (typeof message !== "string") {
    return;
  }
  if (limiter && !limiter.allow(ws)) {
    ws.close(CLOSE_POLICY_VIOLATION, "too many messages");
    return;
  }
  if (message.length > MAX_BODY_BYTES) {
    ws.send(JSON.stringify({ type: "error", code: "body_too_large" }));
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(message);
  } catch {
    return;
  }
  const parsed = WsHeartbeatBody.safeParse(body);
  if (!parsed.success) {
    ws.send(JSON.stringify({ type: "error", code: "invalid_heartbeat" }));
    return;
  }
  const { handle, token } = attachment;
  const { seconds, counters, handles } = parsed.data;
  const result = await core.heartbeat({ handle, token, seconds, counters, handles });
  if (isError(result)) {
    ws.send(JSON.stringify({ type: "error", code: result.code }));
    return;
  }
  ws.send(
    JSON.stringify({
      type: "heartbeat_ack",
      ...userJson(result.user, result.at),
      ...(result.users && { users: result.users.map((u) => userJson(u, result.at)) }),
      ...(result.pings && { pings: result.pings }),
    }),
  );
};
