import type { ServerWebSocket } from "bun";
import app from "./src/index";
import { createHub, type HubCore } from "./src/hub";
import { createLocalDb, createLocalJournal } from "./src/sqlite";
import {
  authorizeUpgrade,
  createWsLimiter,
  deliverPing,
  handleWsMessage,
  helloFrame,
  isRejection,
  pingFrame,
  type Attachment,
  type WsLike,
} from "./src/ws";

const port = Number(process.env.PORT ?? 8787);
const flushMs = Number(process.env.FLUSH_MS ?? 10_000);

let scheduled = false;
const core = createHub(createLocalDb(), createLocalJournal(), () => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    core.flush().catch((err) => console.error("flush failed:", err));
  }, flushMs);
});

const sockets = new Map<string, Set<ServerWebSocket<Attachment>>>();
const limiter = createWsLimiter();

const track = (ws: ServerWebSocket<Attachment>) => {
  const set = sockets.get(ws.data.handle) ?? new Set();
  set.add(ws);
  sockets.set(ws.data.handle, set);
};

const untrack = (ws: ServerWebSocket<Attachment>) => {
  const set = sockets.get(ws.data.handle);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    sockets.delete(ws.data.handle);
  }
};

const stub = {
  register: core.register.bind(core),
  heartbeat: core.heartbeat.bind(core),
  status: core.status.bind(core),
  leaderboard: core.leaderboard.bind(core),
  deleteUser: core.deleteUser.bind(core),
  sendPing: (input: Parameters<HubCore["sendPing"]>[0]) =>
    core.sendPing(input, {
      deliver: () => {
        const targets = [...(sockets.get(input.to) ?? [])] as unknown as WsLike[];
        if (targets.length === 0) {
          return false;
        }
        const frame = pingFrame(input.handle, input.message ?? null, Math.floor(Date.now() / 1000));
        return deliverPing(targets, frame);
      },
    }),
};

const env = { HUB: { idFromName: (name: string) => name, get: () => stub } };

Bun.serve<Attachment>({
  port,
  async fetch(req, server) {
    if (new URL(req.url).pathname === "/api/v1/ws") {
      const auth = await authorizeUpgrade(core, req);
      if (isRejection(auth)) {
        return new Response(auth.message, { status: auth.status });
      }
      if (server.upgrade(req, { data: auth })) {
        return undefined;
      }
      return new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req, env);
  },
  websocket: {
    open(ws) {
      track(ws);
      ws.send(helloFrame(ws.data.handle));
    },
    async message(ws, message) {
      if (typeof message !== "string") {
        return;
      }
      await handleWsMessage(core, ws.data, message, ws as unknown as WsLike, limiter);
    },
    close(ws) {
      untrack(ws);
      limiter.forget(ws as unknown as WsLike);
    },
  },
});
console.log(`friends backend listening on http://127.0.0.1:${port} (in-memory db)`);
