import { expect, setSystemTime, test } from "bun:test";
import {
  createHub,
  isError,
  MAX_PENDING_PINGS_PER_RECIPIENT,
  MIN_PING_GAP_SECONDS,
  PING_TTL_SECONDS,
} from "../src/hub";
import { createLocalDb, createLocalJournal } from "../src/sqlite";

const NOON = 1768046400;
const at = (unix: number) => setSystemTime(new Date(unix * 1000));

const U = { handle: "brave-otter-42", token: "otter-token-0001", ip: "1.2.3.4" };
const LYNX = { handle: "wild-lynx-90", token: "lynx-token-00001", ip: "1.2.3.5" };

const totalInD1 = async (d1: D1Database): Promise<number | undefined> => {
  const row = await d1
    .prepare("SELECT total_seconds FROM users WHERE handle = ?1")
    .bind(U.handle)
    .first<{ total_seconds: number }>();
  return row?.total_seconds;
};

test("flush persists batched usage to D1", async () => {
  const d1 = createLocalDb();
  const hub = createHub(d1, createLocalJournal(), () => {});
  try {
    at(NOON);
    await hub.register(U);
    await hub.heartbeat({ handle: U.handle, token: U.token, seconds: 60 });
    at(NOON + 60);
    await hub.heartbeat({ handle: U.handle, token: U.token, seconds: 60 });

    expect(await totalInD1(d1)).toBe(0);

    await hub.flush();
    expect(await totalInD1(d1)).toBe(120);
    const day = await d1
      .prepare("SELECT seconds FROM usage_days WHERE handle = ?1")
      .bind(U.handle)
      .first<{ seconds: number }>();
    expect(day?.seconds).toBe(120);
  } finally {
    setSystemTime();
  }
});

test("journal replays unflushed time after a restart", async () => {
  const d1 = createLocalDb();
  const journal = createLocalJournal();
  try {
    at(NOON);
    const hub = createHub(d1, journal, () => {});
    await hub.register(U);
    await hub.heartbeat({ handle: U.handle, token: U.token, seconds: 60 });

    const restarted = createHub(d1, journal, () => {});
    const { users } = await restarted.status([U.handle]);
    expect(users[0]?.total_seconds).toBe(60);
    expect(users[0]?.last_seen_at).toBe(NOON);

    await restarted.flush();
    expect(await totalInD1(d1)).toBe(60);
  } finally {
    setSystemTime();
  }
});

test("restart after a flush does not double-count", async () => {
  const d1 = createLocalDb();
  const journal = createLocalJournal();
  try {
    at(NOON);
    const hub = createHub(d1, journal, () => {});
    await hub.register(U);
    await hub.heartbeat({ handle: U.handle, token: U.token, seconds: 60 });
    await hub.flush();
    at(NOON + 60);
    await hub.heartbeat({ handle: U.handle, token: U.token, seconds: 60 });

    const restarted = createHub(d1, journal, () => {});
    const { users } = await restarted.status([U.handle]);
    expect(users[0]?.total_seconds).toBe(120);

    await restarted.flush();
    expect(await totalInD1(d1)).toBe(120);
  } finally {
    setSystemTime();
  }
});

test("flush persists counters to D1 and journal replays them after a restart", async () => {
  const d1 = createLocalDb();
  const journal = createLocalJournal();
  try {
    at(NOON);
    const hub = createHub(d1, journal, () => {});
    await hub.register(U);
    await hub.heartbeat({ handle: U.handle, token: U.token, seconds: 60, counters: { keys_pressed: 500 } });
    at(NOON + 60);
    await hub.heartbeat({ handle: U.handle, token: U.token, seconds: 60, counters: { keys_pressed: 250 } });

    const restarted = createHub(d1, journal, () => {});
    const { users } = await restarted.status([U.handle]);
    expect(users[0]?.counters).toEqual({ keys_pressed: 750 });

    await restarted.flush();
    const row = await d1
      .prepare("SELECT counters FROM users WHERE handle = ?1")
      .bind(U.handle)
      .first<{ counters: string }>();
    expect(JSON.parse(row?.counters ?? "{}")).toEqual({ keys_pressed: 750 });
  } finally {
    setSystemTime();
  }
});

test("heartbeat clamps counters over their cap instead of rejecting the request", async () => {
  const d1 = createLocalDb();
  const hub = createHub(d1, createLocalJournal(), () => {});
  try {
    at(NOON);
    await hub.register(U);
    const result = await hub.heartbeat({
      handle: U.handle,
      token: U.token,
      seconds: 60,
      counters: { keys_pressed: 25000 },
    });
    expect(isError(result)).toBe(false);
    if (!isError(result)) {
      expect(result.user.total_seconds).toBe(60);
      expect(result.user.counters).toEqual({ keys_pressed: 20000 });
    }
  } finally {
    setSystemTime();
  }
});

test("flush failure keeps pending time for the next attempt", async () => {
  const d1 = createLocalDb();
  const journal = createLocalJournal();
  const hub = createHub(d1, journal, () => {});
  try {
    at(NOON);
    await hub.register(U);
    await hub.heartbeat({ handle: U.handle, token: U.token, seconds: 60 });

    const batch = d1.batch.bind(d1);
    d1.batch = () => {
      throw new Error("d1 unavailable");
    };
    await expect(hub.flush()).rejects.toThrow("d1 unavailable");
    d1.batch = batch;

    await hub.flush();
    expect(await totalInD1(d1)).toBe(60);
  } finally {
    setSystemTime();
  }
});

test("ping: send and poll round trip drains the queue", async () => {
  const d1 = createLocalDb();
  const hub = createHub(d1, createLocalJournal(), () => {});
  try {
    at(NOON);
    await hub.register(U);
    await hub.register(LYNX);
    const sent = await hub.sendPing({
      handle: U.handle,
      token: U.token,
      to: LYNX.handle,
      message: "hey",
    });
    expect(isError(sent)).toBe(false);

    const result = await hub.checkPings({ handle: LYNX.handle, token: LYNX.token });
    expect(isError(result)).toBe(false);
    if (!isError(result)) {
      expect(result.pings).toEqual([{ from: U.handle, message: "hey", at: NOON }]);
    }

    const drained = await hub.checkPings({ handle: LYNX.handle, token: LYNX.token });
    expect(isError(drained)).toBe(false);
    if (!isError(drained)) {
      expect(drained.pings).toEqual([]);
    }
  } finally {
    setSystemTime();
  }
});

test("ping: survives a restart via the journal", async () => {
  const d1 = createLocalDb();
  const journal = createLocalJournal();
  try {
    at(NOON);
    const hub = createHub(d1, journal, () => {});
    await hub.register(U);
    await hub.register(LYNX);
    await hub.sendPing({ handle: U.handle, token: U.token, to: LYNX.handle });

    const restarted = createHub(d1, journal, () => {});
    const result = await restarted.checkPings({ handle: LYNX.handle, token: LYNX.token });
    expect(isError(result)).toBe(false);
    if (!isError(result)) {
      expect(result.pings).toHaveLength(1);
      expect(result.pings[0]?.from).toBe(U.handle);
    }
  } finally {
    setSystemTime();
  }
});

test("ping: cooldown rejects rapid pings from the same sender", async () => {
  const d1 = createLocalDb();
  const hub = createHub(d1, createLocalJournal(), () => {});
  try {
    at(NOON);
    await hub.register(U);
    await hub.register(LYNX);
    await hub.sendPing({ handle: U.handle, token: U.token, to: LYNX.handle });
    const second = await hub.sendPing({ handle: U.handle, token: U.token, to: LYNX.handle });
    expect(isError(second) && second.status).toBe(429);

    at(NOON + MIN_PING_GAP_SECONDS);
    const third = await hub.sendPing({ handle: U.handle, token: U.token, to: LYNX.handle });
    expect(isError(third)).toBe(false);
  } finally {
    setSystemTime();
  }
});

test("ping: 404s an unknown recipient", async () => {
  const d1 = createLocalDb();
  const hub = createHub(d1, createLocalJournal(), () => {});
  try {
    at(NOON);
    await hub.register(U);
    const result = await hub.sendPing({
      handle: U.handle,
      token: U.token,
      to: "nobody-here-00",
    });
    expect(isError(result) && result.status).toBe(404);
  } finally {
    setSystemTime();
  }
});

test("ping: rejects the wrong sender token", async () => {
  const d1 = createLocalDb();
  const hub = createHub(d1, createLocalJournal(), () => {});
  try {
    at(NOON);
    await hub.register(U);
    await hub.register(LYNX);
    const result = await hub.sendPing({
      handle: U.handle,
      token: "someone-elses-token",
      to: LYNX.handle,
    });
    expect(isError(result) && result.status).toBe(403);
  } finally {
    setSystemTime();
  }
});

test("ping: queue caps at MAX_PENDING_PINGS_PER_RECIPIENT, dropping the oldest", async () => {
  const d1 = createLocalDb();
  const hub = createHub(d1, createLocalJournal(), () => {});
  try {
    await hub.register(LYNX);
    for (let i = 0; i < MAX_PENDING_PINGS_PER_RECIPIENT + 1; i++) {
      at(NOON + i * MIN_PING_GAP_SECONDS);
      const sender = {
        handle: `sender-user-${String(i).padStart(2, "0")}`,
        token: `sender-token-000${i}`,
        ip: `9.9.9.${i}`,
      };
      await hub.register(sender);
      await hub.sendPing({
        handle: sender.handle,
        token: sender.token,
        to: LYNX.handle,
        message: String(i),
      });
    }
    const result = await hub.checkPings({ handle: LYNX.handle, token: LYNX.token });
    expect(isError(result)).toBe(false);
    if (!isError(result)) {
      expect(result.pings).toHaveLength(MAX_PENDING_PINGS_PER_RECIPIENT);
      expect(result.pings[0]?.message).toBe("1");
      expect(result.pings.at(-1)?.message).toBe(String(MAX_PENDING_PINGS_PER_RECIPIENT));
    }
  } finally {
    setSystemTime();
  }
});

test("ping: drops pings older than PING_TTL_SECONDS", async () => {
  const d1 = createLocalDb();
  const hub = createHub(d1, createLocalJournal(), () => {});
  try {
    at(NOON);
    await hub.register(U);
    await hub.register(LYNX);
    await hub.sendPing({ handle: U.handle, token: U.token, to: LYNX.handle });

    at(NOON + PING_TTL_SECONDS + 1);
    const result = await hub.checkPings({ handle: LYNX.handle, token: LYNX.token });
    expect(isError(result)).toBe(false);
    if (!isError(result)) {
      expect(result.pings).toEqual([]);
    }
  } finally {
    setSystemTime();
  }
});
