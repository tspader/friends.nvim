import { DurableObject } from "cloudflare:workers";
import { createHub, FLUSH_INTERVAL_SECONDS, type HubCore } from "./hub";
import {
  authorizeUpgrade,
  createWsLimiter,
  deliverPing,
  handleWsMessage,
  helloFrame,
  isRejection,
  pingFrame,
  safeCloseCode,
  type Attachment,
  type WsLike,
} from "./ws";

type Env = { DB: D1Database };

export class Hub extends DurableObject<Env> {
  private core: HubCore;
  private limiter = createWsLimiter();

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
    return this.core.sendPing(input, {
      deliver: () => {
        const sockets = this.ctx.getWebSockets(input.to) as unknown as WsLike[];
        if (sockets.length === 0) {
          return false;
        }
        const frame = pingFrame(input.handle, input.message ?? null, Math.floor(Date.now() / 1000));
        return deliverPing(sockets, frame);
      },
    });
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
    const auth = await authorizeUpgrade(this.core, request);
    if (isRejection(auth)) {
      return new Response(auth.message, { status: auth.status });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [auth.handle]);
    pair[1].serializeAttachment(auth);
    pair[1].send(helloFrame(auth.handle));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment() as Attachment;
    await handleWsMessage(
      this.core,
      attachment,
      message,
      ws as unknown as WsLike,
      this.limiter,
    );
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.limiter.forget(ws as unknown as WsLike);
    ws.close(safeCloseCode(code), reason);
  }
}
