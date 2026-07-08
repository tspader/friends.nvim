import { expect, test } from "bun:test";
import { createHub, type Journal } from "../src/hub";
import { migrateJournal } from "../src/journal-migrations";
import { COUNTER_METRIC_NAMES } from "../src/metrics";
import { HeartbeatBody } from "../src/schema";
import { createLocalDb, createLocalJournal } from "../src/sqlite";

const journalFromDeploy = (version: number): Journal => {
  const journal = createLocalJournal();
  migrateJournal(journal, version);
  return journal;
};

test("unflushed seconds in a v1 pending table survive the deploy", async () => {
  const d1 = createLocalDb();
  const setup = createHub(d1, createLocalJournal(), () => {});
  await setup.register({ handle: "old-timer", token: "tok_1234567890", ip: "1.1.1.1" });

  // What the v1 deploy left behind: a pending row it never flushed.
  const journal = journalFromDeploy(1);
  journal.exec(
    "INSERT INTO pending (handle, day, day_seconds, total_seconds, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    "old-timer",
    "2020-01-01",
    120,
    120,
    1577836800,
  );

  const hub = createHub(d1, journal, () => {});
  const { users } = await hub.status(["old-timer"]);
  expect(users).toHaveLength(1);
  expect(users[0]?.total_seconds).toBe(120);
  expect(users[0]?.last_seen_at).toBe(1577836800);

  // The migrated journal hydrates cleanly again on the next deploy.
  const again = await createHub(d1, journal, () => {}).status(["old-timer"]);
  expect(again.users[0]?.total_seconds).toBe(120);
});

test("a v2 pending table with no version marker survives the deploy", async () => {
  const d1 = createLocalDb();
  const setup = createHub(d1, createLocalJournal(), () => {});
  await setup.register({ handle: "old-timer", token: "tok_1234567890", ip: "1.1.1.1" });

  const journal = journalFromDeploy(2);
  journal.exec(
    "INSERT INTO pending (handle, day, day_seconds, total_seconds, last_seen_at, counters, day_counters) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    "old-timer",
    "2020-01-01",
    120,
    120,
    1577836800,
    '{"keys_pressed":42}',
    '{"keys_pressed":42}',
  );

  const hub = createHub(d1, journal, () => {});
  const { users } = await hub.status(["old-timer"]);
  expect(users[0]?.total_seconds).toBe(120);
  expect(users[0]?.counters).toEqual({ keys_pressed: 42 });
});

test("a failed hydration is retried on the next request", async () => {
  const d1 = createLocalDb();
  let failures = 1;
  const flaky = {
    prepare: (sql: string) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("transient D1 error");
      }
      return d1.prepare(sql);
    },
    batch: (stmts: unknown[]) => d1.batch(stmts as never),
  } as unknown as D1Database;
  const hub = createHub(flaky, createLocalJournal(), () => {});
  expect(hub.status(["nobody"])).rejects.toThrow("transient D1 error");
  const { users } = await hub.status(["nobody"]);
  expect(users).toEqual([]);
});

test("heartbeat accepts an empty counters object", () => {
  const body = { token: "tok_1234567890", seconds: 60, counters: {} };
  expect(HeartbeatBody.safeParse(body).success).toBe(true);
});

test("heartbeat accepts counters naming only one known metric", () => {
  // This is for when we ship more metrics. It'll show that an old client that
  // doesn't send a new metric yet still works. For now, it's vacuous
  for (const name of COUNTER_METRIC_NAMES) {
    const body = { token: "tok_1234567890", seconds: 60, counters: { [name]: 5 } };
    expect(HeartbeatBody.safeParse(body).success).toBe(true);
  }
});
