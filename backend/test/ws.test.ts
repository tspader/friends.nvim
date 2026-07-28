import { expect, setSystemTime, test } from "bun:test";
import { createHub, isError, MIN_HEARTBEAT_GAP_SECONDS, type HubCore } from "../src/hub";
import { MAX_BODY_BYTES } from "../src/schema";
import { createLocalDb, createLocalJournal } from "../src/sqlite";
import {
  authorizeUpgrade,
  createWsLimiter,
  deliverPing,
  handleWsMessage,
  helloFrame,
  isRejection,
  safeCloseCode,
  WS_OPEN,
  type Attachment,
  type WsLike,
} from "../src/ws";

const NOON = 1768046400;
const at = (unix: number) => setSystemTime(new Date(unix * 1000));

const U = { handle: "brave-otter-42", token: "otter-token-0001", ip: "1.2.3.4" };
const LYNX = { handle: "wild-lynx-90", token: "lynx-token-00001", ip: "1.2.3.5" };

type FakeSocket = WsLike & {
  sent: Record<string, unknown>[];
  closed: { code?: number; reason?: string } | null;
  last(): Record<string, unknown> | undefined;
};

const fakeSocket = (readyState = WS_OPEN): FakeSocket => ({
  readyState,
  sent: [],
  closed: null,
  send(data) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  },
  close(code, reason) {
    this.closed = { code, reason };
  },
  last() {
    return this.sent.at(-1);
  },
});

const hubWith = async (...users: (typeof U)[]): Promise<HubCore> => {
  const hub = createHub(createLocalDb(), createLocalJournal(), () => {});
  for (const user of users) {
    await hub.register(user);
  }
  return hub;
};

const attachment = (user: typeof U): Attachment => ({ handle: user.handle, token: user.token });

const upgradeRequest = (headers: Record<string, string>) =>
  new Request("https://example.com/api/v1/ws", { headers });

test("ws: a heartbeat over a socket credits time and acks", async () => {
  try {
    at(NOON);
    const hub = await hubWith(U);
    const ws = fakeSocket();

    await handleWsMessage(hub, attachment(U), JSON.stringify({ type: "heartbeat", seconds: 60 }), ws);

    expect(ws.last()).toMatchObject({
      type: "heartbeat_ack",
      handle: U.handle,
      total_seconds: 60,
      active: true,
    });
    const { users } = await hub.status([U.handle]);
    expect(users[0]?.total_seconds).toBe(60);
  } finally {
    setSystemTime();
  }
});

test("ws: a heartbeat with a roster returns friend status", async () => {
  try {
    at(NOON);
    const hub = await hubWith(U, LYNX);
    const ws = fakeSocket();

    await handleWsMessage(
      hub,
      attachment(U),
      JSON.stringify({ type: "heartbeat", seconds: 60, handles: [LYNX.handle] }),
      ws,
    );

    const ack = ws.last() as { users?: { handle: string }[] };
    expect(ack.users).toHaveLength(1);
    expect(ack.users?.[0]?.handle).toBe(LYNX.handle);
  } finally {
    setSystemTime();
  }
});

test("ws: a pending ping rides the heartbeat ack", async () => {
  try {
    at(NOON);
    const hub = await hubWith(U, LYNX);
    await hub.sendPing({ handle: U.handle, token: U.token, to: LYNX.handle, message: "hey" });
    const ws = fakeSocket();

    await handleWsMessage(hub, attachment(LYNX), JSON.stringify({ type: "heartbeat", seconds: 1 }), ws);

    expect(ws.last()).toMatchObject({ pings: [{ from: U.handle, message: "hey", at: NOON }] });
  } finally {
    setSystemTime();
  }
});

// The client used to send its roster unguarded, so a user with no friends sent
// [] and every heartbeat they made was rejected -- silently, and forever.
test("ws: an empty handles array is rejected", async () => {
  try {
    at(NOON);
    const hub = await hubWith(U);
    const ws = fakeSocket();

    await handleWsMessage(
      hub,
      attachment(U),
      JSON.stringify({ type: "heartbeat", seconds: 60, handles: [] }),
      ws,
    );

    expect(ws.last()).toEqual({ type: "error", code: "invalid_heartbeat" });
    const { users } = await hub.status([U.handle]);
    expect(users[0]?.total_seconds).toBe(0);
  } finally {
    setSystemTime();
  }
});

test("ws: a malformed heartbeat is rejected with a code the client can route on", async () => {
  try {
    at(NOON);
    const hub = await hubWith(U);
    const ws = fakeSocket();

    await handleWsMessage(hub, attachment(U), JSON.stringify({ type: "heartbeat" }), ws);

    expect(ws.last()).toEqual({ type: "error", code: "invalid_heartbeat" });
  } finally {
    setSystemTime();
  }
});

test("ws: unparseable json is dropped without a reply", async () => {
  const hub = await hubWith(U);
  const ws = fakeSocket();

  await handleWsMessage(hub, attachment(U), "{not json", ws);

  expect(ws.sent).toHaveLength(0);
});

test("ws: an unknown handle returns an error frame carrying the code", async () => {
  try {
    at(NOON);
    const hub = await hubWith();
    const ws = fakeSocket();

    await handleWsMessage(
      hub,
      { handle: "nobody-here-00", token: "some-token-0000" },
      JSON.stringify({ type: "heartbeat", seconds: 60 }),
      ws,
    );

    expect(ws.last()).toEqual({ type: "error", code: "unknown_handle" });
  } finally {
    setSystemTime();
  }
});

test("ws: the heartbeat cooldown surfaces as an error frame", async () => {
  try {
    at(NOON);
    const hub = await hubWith(U);
    const ws = fakeSocket();
    const frame = JSON.stringify({ type: "heartbeat", seconds: 60 });

    await handleWsMessage(hub, attachment(U), frame, ws);
    await handleWsMessage(hub, attachment(U), frame, ws);
    expect(ws.last()).toEqual({ type: "error", code: "heartbeat_cooldown" });

    at(NOON + MIN_HEARTBEAT_GAP_SECONDS);
    await handleWsMessage(hub, attachment(U), frame, ws);
    expect(ws.last()).toMatchObject({ type: "heartbeat_ack" });
  } finally {
    setSystemTime();
  }
});

test("ws: an oversized frame is rejected before it is parsed", async () => {
  const hub = await hubWith(U);
  const ws = fakeSocket();
  const padded = JSON.stringify({
    type: "heartbeat",
    seconds: 60,
    pad: "x".repeat(MAX_BODY_BYTES),
  });

  await handleWsMessage(hub, attachment(U), padded, ws);

  expect(ws.last()).toEqual({ type: "error", code: "body_too_large" });
  const { users } = await hub.status([U.handle]);
  expect(users[0]?.total_seconds).toBe(0);
});

test("ws: binary frames are ignored", async () => {
  const hub = await hubWith(U);
  const ws = fakeSocket();

  await handleWsMessage(hub, attachment(U), new ArrayBuffer(8), ws);

  expect(ws.sent).toHaveLength(0);
});

test("ws: the limiter closes a socket that floods frames", async () => {
  const hub = await hubWith(U);
  const ws = fakeSocket();
  const limiter = createWsLimiter(3, 60_000);
  const frame = JSON.stringify({ type: "heartbeat", seconds: 60 });

  for (let i = 0; i < 4; i++) {
    await handleWsMessage(hub, attachment(U), frame, ws, limiter);
  }

  expect(ws.closed).toEqual({ code: 1008, reason: "too many messages" });
});

test("ws: the limiter budget resets once the window rolls over", async () => {
  try {
    at(NOON);
    const limiter = createWsLimiter(2, 60_000);
    const ws = fakeSocket();

    expect(limiter.allow(ws)).toBe(true);
    expect(limiter.allow(ws)).toBe(true);
    expect(limiter.allow(ws)).toBe(false);

    at(NOON + 60);
    expect(limiter.allow(ws)).toBe(true);
  } finally {
    setSystemTime();
  }
});

test("ws: the limiter tracks each socket separately", async () => {
  const limiter = createWsLimiter(1, 60_000);
  const a = fakeSocket();
  const b = fakeSocket();

  expect(limiter.allow(a)).toBe(true);
  expect(limiter.allow(a)).toBe(false);
  expect(limiter.allow(b)).toBe(true);
});

test("authorizeUpgrade: accepts a valid handle and token", async () => {
  try {
    at(NOON);
    const hub = await hubWith(U);

    const result = await authorizeUpgrade(
      hub,
      upgradeRequest({ "X-Friends-Handle": U.handle, "X-Friends-Token": U.token }),
    );

    expect(isRejection(result)).toBe(false);
    expect(result).toEqual({ handle: U.handle, token: U.token });
  } finally {
    setSystemTime();
  }
});

test("authorizeUpgrade: rejects missing credentials", async () => {
  const hub = await hubWith(U);

  const noToken = await authorizeUpgrade(hub, upgradeRequest({ "X-Friends-Handle": U.handle }));
  expect(isRejection(noToken) && noToken.status).toBe(401);

  const neither = await authorizeUpgrade(hub, upgradeRequest({}));
  expect(isRejection(neither) && neither.status).toBe(401);
});

test("authorizeUpgrade: rejects an unknown handle and a wrong token", async () => {
  try {
    at(NOON);
    const hub = await hubWith(U);

    const unknown = await authorizeUpgrade(
      hub,
      upgradeRequest({ "X-Friends-Handle": "nobody-here-00", "X-Friends-Token": U.token }),
    );
    expect(isRejection(unknown) && unknown.status).toBe(401);

    const wrong = await authorizeUpgrade(
      hub,
      upgradeRequest({ "X-Friends-Handle": U.handle, "X-Friends-Token": "someone-elses-token" }),
    );
    expect(isRejection(wrong) && wrong.status).toBe(401);
  } finally {
    setSystemTime();
  }
});

test("deliverPing: sends to open sockets and reports delivery", () => {
  const a = fakeSocket();
  const b = fakeSocket();

  expect(deliverPing([a, b], JSON.stringify({ type: "ping", from: U.handle }))).toBe(true);
  expect(a.sent).toHaveLength(1);
  expect(b.sent).toHaveLength(1);
});

test("deliverPing: skips sockets that are not open", () => {
  const closing = fakeSocket(2);
  const closed = fakeSocket(3);

  expect(deliverPing([closing, closed], "{}")).toBe(false);
  expect(closing.sent).toHaveLength(0);
  expect(closed.sent).toHaveLength(0);
});

test("deliverPing: a throwing socket does not count as delivered", () => {
  const broken: WsLike = {
    readyState: WS_OPEN,
    send() {
      throw new Error("socket gone");
    },
    close() {},
  };

  expect(deliverPing([broken], "{}")).toBe(false);
});

test("deliverPing: reports delivery when at least one socket takes it", () => {
  const open = fakeSocket();
  const gone = fakeSocket(3);

  expect(deliverPing([gone, open], "{}")).toBe(true);
  expect(open.sent).toHaveLength(1);
});

test("safeCloseCode: clamps codes close() will not accept", () => {
  // 1005 (no status) and 1006 (abnormal) are observed but unsettable.
  expect(safeCloseCode(1005)).toBe(1000);
  expect(safeCloseCode(1006)).toBe(1000);
  expect(safeCloseCode(1001)).toBe(1000);
  expect(safeCloseCode(1000)).toBe(1000);
  expect(safeCloseCode(3000)).toBe(3000);
  expect(safeCloseCode(4999)).toBe(4999);
  expect(safeCloseCode(5000)).toBe(1000);
});

test("helloFrame: names the handle the server attached the socket under", () => {
  expect(JSON.parse(helloFrame(U.handle))).toEqual({ type: "hello", handle: U.handle });
});
