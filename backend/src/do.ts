import { DurableObject } from "cloudflare:workers";
import { createHub, FLUSH_INTERVAL_SECONDS, isError, userJson, type HubCore } from "./hub";
import { WsHeartbeatBody } from "./schema";

type Env = { DB: D1Database };

export class Hub extends DurableObject<Env> {
  private core: HubCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = createHub(env.DB, ctx.storage.sql, async () => {
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_SECONDS * 1000);
      }
    });
  }

  register(input: Parameters<HubCore["register"]>[0]) {
    return this.core.register(input);
  }

  heartbeat(input: Parameters<HubCore["heartbeat"]>[0]) {
    return this.core.heartbeat(input);
  }

  deleteUser(input: Parameters<HubCore["deleteUser"]>[0]) {
    return this.core.deleteUser(input);
  }

  status(handles: string[]) {
    return this.core.status(handles);
  }

  sendPing(input: Parameters<HubCore["sendPing"]>[0]) {
    const sockets = this.ctx.getWebSockets(input.to);
    let deliveredLive = false;
    if (sockets.length > 0) {
      const frame = JSON.stringify({
        type: "ping",
        from: input.handle,
        message: input.message ?? null,
        at: Math.floor(Date.now() / 1000),
      });
      for (const ws of sockets) {
        try {
          ws.send(frame);
          deliveredLive = true;
        } catch {
          // socket race; fall through to the durable queue below
        }
      }
    }
    return this.core.sendPing(input, { deliveredLive });
  }

  leaderboard(query: Parameters<HubCore["leaderboard"]>[0]) {
    return this.core.leaderboard(query);
  }

  async alarm() {
    await this.core.flush();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const handle = request.headers.get("X-Friends-Handle");
    const token = request.headers.get("X-Friends-Token");
    if (!handle || !token) {
      return new Response("missing credentials", { status: 401 });
    }
    const auth = await this.core.authenticate(handle, token);
    if (isError(auth)) {
      return new Response("unauthorized", { status: 401 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [handle]);
    pair[1].serializeAttachment({ handle, token });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") {
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
      ws.send(JSON.stringify({ type: "error", error: "invalid heartbeat" }));
      return;
    }
    const { handle, token } = ws.deserializeAttachment() as { handle: string; token: string };
    const { seconds, counters, handles } = parsed.data;
    const result = await this.core.heartbeat({ handle, token, seconds, counters, handles });
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
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code, reason);
  }
}
