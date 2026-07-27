import { createDb, parseCounters, utcDay, type Db, type User } from "./db";
import { migrateJournal } from "./journal-migrations";
import { COUNTER_METRICS } from "./metrics";
import type { Metric, Period } from "./schema";

export const FLUSH_INTERVAL_SECONDS = 600;
export const MIN_HEARTBEAT_GAP_SECONDS = 15;
export const MAX_REGISTRATIONS_PER_DAY = 1000;
export const MAX_REGISTRATIONS_PER_IP_PER_DAY = 20;
export const MAX_PENDING_PINGS_PER_RECIPIENT = 20;
export const PING_TTL_SECONDS = 600;
export const MIN_PING_GAP_SECONDS = 3;

const MEMORY_DAYS = 7;
const D1_RETENTION_DAYS = 10;
const FLUSH_CHUNK = 100;

type DayBucket = { seconds: number; counters: Record<string, number> };
type UserState = User & { token: string; days: Map<string, DayBucket> };

export type HubErrorCode =
  | "handle_taken"
  | "registration_limit"
  | "ip_registration_limit"
  | "unknown_handle"
  | "unknown_recipient"
  | "wrong_token"
  | "heartbeat_cooldown"
  | "ping_cooldown";

export type HubError = { code: HubErrorCode };

export type LeaderboardEntry = User & { value: number };

export type PendingPing = { from: string; message: string | null; at: number };

const mergeCounters = (
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> => {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    out[key] = Math.max(out[key] ?? 0, value);
  }
  return out;
};

export type Journal = {
  exec(
    sql: string,
    ...params: (string | number | null)[]
  ): { toArray(): Record<string, unknown>[] };
};

const isError = (result: unknown): result is HubError =>
  typeof result === "object" && result !== null && "code" in result;

const publicUser = (user: UserState): User => ({
  handle: user.handle,
  display_name: user.display_name,
  total_seconds: user.total_seconds,
  last_seen_at: user.last_seen_at,
  counters: user.counters,
});

const dayKey = (handle: string, day: string) => `${handle}\n${day}`;

export class HubCore {
  private users = new Map<string, UserState>();
  private dirty = new Set<string>();
  private dirtyDays = new Set<string>();
  private hydration: Promise<void> | null = null;
  private regDay = "";
  private regCount = 0;
  private regByIp = new Map<string, number>();
  private lastPingAt = new Map<string, number>();
  private lastPruneDay = "";

  constructor(
    private db: Db,
    private journal: Journal,
    private requestFlush: () => void | Promise<void>,
  ) {}

  private now = () => Math.floor(Date.now() / 1000);

  private ensureHydrated(): Promise<void> {
    this.hydration ??= this.hydrate().catch((err) => {
      this.hydration = null;
      throw err;
    });
    return this.hydration;
  }

  private async hydrate(): Promise<void> {
    migrateJournal(this.journal);
    const at = this.now();
    for (const row of await this.db.allUsers()) {
      this.users.set(row.handle, { ...row, days: new Map() });
    }
    const since = utcDay(at - (MEMORY_DAYS - 1) * 86400);
    for (const row of await this.db.usageDaysSince(since)) {
      this.users.get(row.handle)?.days.set(row.day, { seconds: row.seconds, counters: row.counters });
    }
    for (const row of this.journal
      .exec(
        "SELECT handle, day, day_seconds, total_seconds, last_seen_at, counters, day_counters FROM pending",
      )
      .toArray()) {
      const handle = row.handle as string;
      const day = row.day as string;
      const user = this.users.get(handle);
      if (!user) continue;
      user.total_seconds = Math.max(user.total_seconds, row.total_seconds as number);
      user.last_seen_at = Math.max(user.last_seen_at ?? 0, row.last_seen_at as number);
      user.counters = mergeCounters(user.counters, parseCounters(row.counters));
      const bucket = user.days.get(day) ?? { seconds: 0, counters: {} };
      user.days.set(day, {
        seconds: Math.max(bucket.seconds, row.day_seconds as number),
        counters: mergeCounters(bucket.counters, parseCounters(row.day_counters)),
      });
      this.dirty.add(handle);
      this.dirtyDays.add(dayKey(handle, day));
    }
    if (this.dirty.size > 0) {
      await this.requestFlush();
    }
  }

  async register(input: {
    handle: string;
    token: string;
    display_name?: string;
    ip: string;
  }): Promise<HubError | { user: User; at: number }> {
    await this.ensureHydrated();
    const at = this.now();
    const existing = this.users.get(input.handle);
    if (existing) {
      if (existing.token !== input.token) {
        return { code: "handle_taken" };
      }
      if (input.display_name !== undefined && input.display_name !== existing.display_name) {
        await this.db.setDisplayName(input.handle, input.display_name);
        existing.display_name = input.display_name;
      }
      return { user: publicUser(existing), at };
    }

    const today = utcDay(at);
    if (today !== this.regDay) {
      this.regDay = today;
      this.regCount = 0;
      this.regByIp.clear();
    }
    if (this.regCount >= MAX_REGISTRATIONS_PER_DAY) {
      return { code: "registration_limit" };
    }
    const ipCount = this.regByIp.get(input.ip) ?? 0;
    if (ipCount >= MAX_REGISTRATIONS_PER_IP_PER_DAY) {
      return { code: "ip_registration_limit" };
    }

    const user: UserState = {
      handle: input.handle,
      token: input.token,
      display_name: input.display_name ?? null,
      total_seconds: 0,
      last_seen_at: null,
      counters: {},
      days: new Map(),
    };
    await this.db.insertUser({
      handle: input.handle,
      token: input.token,
      display_name: user.display_name,
      at,
    });
    this.users.set(input.handle, user);
    this.regCount += 1;
    this.regByIp.set(input.ip, ipCount + 1);
    return { user: publicUser(user), at };
  }

  async heartbeat(input: {
    handle: string;
    token: string;
    seconds: number;
    counters?: Partial<Record<string, number>>;
    handles?: string[];
  }): Promise<HubError | { user: User; users?: User[]; pings?: PendingPing[]; at: number }> {
    await this.ensureHydrated();
    const user = this.users.get(input.handle);
    if (!user) {
      return { code: "unknown_handle" };
    }
    if (user.token !== input.token) {
      return { code: "wrong_token" };
    }
    const at = this.now();
    let credited = input.seconds;
    if (user.last_seen_at !== null) {
      const gap = at - user.last_seen_at;
      if (gap < MIN_HEARTBEAT_GAP_SECONDS) {
        return { code: "heartbeat_cooldown" };
      }
      credited = Math.min(input.seconds, gap);
    }
    const day = utcDay(at);
    user.total_seconds += credited;
    const bucket = user.days.get(day) ?? { seconds: 0, counters: {} };
    bucket.seconds += credited;
    for (const [key, value] of Object.entries(input.counters ?? {})) {
      if (value === undefined) continue;
      const max = COUNTER_METRICS[key as keyof typeof COUNTER_METRICS]?.max;
      const credit = max !== undefined ? Math.min(value, max) : value;
      user.counters[key] = (user.counters[key] ?? 0) + credit;
      bucket.counters[key] = (bucket.counters[key] ?? 0) + credit;
    }
    user.days.set(day, bucket);
    user.last_seen_at = at;
    this.journal.exec(
      "INSERT INTO pending (handle, day, day_seconds, total_seconds, last_seen_at, counters, day_counters) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
        "ON CONFLICT(handle, day) DO UPDATE SET day_seconds = excluded.day_seconds, " +
        "total_seconds = excluded.total_seconds, last_seen_at = excluded.last_seen_at, " +
        "counters = excluded.counters, day_counters = excluded.day_counters",
      input.handle,
      day,
      bucket.seconds,
      user.total_seconds,
      at,
      JSON.stringify(user.counters),
      JSON.stringify(bucket.counters),
    );
    this.dirty.add(input.handle);
    this.dirtyDays.add(dayKey(input.handle, day));
    await this.requestFlush();

    const result: { user: User; users?: User[]; pings?: PendingPing[]; at: number } = {
      user: publicUser(user),
      at,
    };
    if (input.handles) {
      result.users = this.lookup(input.handles);
    }
    const pings = this.drainPings(input.handle, at);
    if (pings.length > 0) {
      result.pings = pings;
    }
    return result;
  }

  async deleteUser(input: {
    handle: string;
    token: string;
  }): Promise<HubError | { ok: true }> {
    await this.ensureHydrated();
    const user = this.users.get(input.handle);
    if (!user) {
      return { code: "unknown_handle" };
    }
    if (user.token !== input.token) {
      return { code: "wrong_token" };
    }
    await this.db.deleteUser(input.handle);
    this.users.delete(input.handle);
    this.dirty.delete(input.handle);
    for (const day of user.days.keys()) {
      this.dirtyDays.delete(dayKey(input.handle, day));
    }
    this.journal.exec("DELETE FROM pending WHERE handle = ?1", input.handle);
    this.journal.exec(
      "DELETE FROM pings WHERE to_handle = ?1 OR from_handle = ?1",
      input.handle,
    );
    this.lastPingAt.delete(input.handle);
    return { ok: true };
  }

  async sendPing(input: {
    handle: string;
    token: string;
    to: string;
    message?: string;
  }): Promise<HubError | { ok: true }> {
    await this.ensureHydrated();
    const sender = this.users.get(input.handle);
    if (!sender) {
      return { code: "unknown_handle" };
    }
    if (sender.token !== input.token) {
      return { code: "wrong_token" };
    }
    if (!this.users.has(input.to)) {
      return { code: "unknown_recipient" };
    }
    const at = this.now();
    const last = this.lastPingAt.get(input.handle);
    if (last !== undefined && at - last < MIN_PING_GAP_SECONDS) {
      return { code: "ping_cooldown" };
    }
    const pending = this.journal
      .exec("SELECT COUNT(*) AS count FROM pings WHERE to_handle = ?1", input.to)
      .toArray()[0]?.count as number;
    if (pending >= MAX_PENDING_PINGS_PER_RECIPIENT) {
      this.journal.exec(
        "DELETE FROM pings WHERE id IN " +
          "(SELECT id FROM pings WHERE to_handle = ?1 ORDER BY at ASC, id ASC LIMIT 1)",
        input.to,
      );
    }
    this.journal.exec(
      "INSERT INTO pings (to_handle, from_handle, message, at) VALUES (?1, ?2, ?3, ?4)",
      input.to,
      input.handle,
      input.message ?? null,
      at,
    );
    this.lastPingAt.set(input.handle, at);
    return { ok: true };
  }

  private drainPings(handle: string, at: number): PendingPing[] {
    const rows = this.journal
      .exec(
        "SELECT from_handle, message, at FROM pings WHERE to_handle = ?1 ORDER BY at ASC, id ASC",
        handle,
      )
      .toArray();
    if (rows.length === 0) {
      return [];
    }
    this.journal.exec("DELETE FROM pings WHERE to_handle = ?1", handle);
    return rows
      .filter((row) => at - (row.at as number) <= PING_TTL_SECONDS)
      .map((row) => ({
        from: row.from_handle as string,
        message: (row.message as string | null) ?? null,
        at: row.at as number,
      }));
  }

  async status(handles: string[]): Promise<{ users: User[]; at: number }> {
    await this.ensureHydrated();
    return { users: this.lookup(handles), at: this.now() };
  }

  private lookup(handles: string[]): User[] {
    return handles.flatMap((handle) => {
      const user = this.users.get(handle);
      return user ? [publicUser(user)] : [];
    });
  }

  async leaderboard(query: {
    period: Period;
    metric: Metric;
    limit: number;
    handles?: string[];
  }): Promise<{ entries: LeaderboardEntry[]; at: number }> {
    await this.ensureHydrated();
    const at = this.now();
    const pool = query.handles
      ? query.handles.flatMap((handle) => this.users.get(handle) ?? [])
      : [...this.users.values()];

    const since = query.period === "today" ? utcDay(at) : utcDay(at - 6 * 86400);
    const value = (user: UserState): number => {
      if (query.metric === "active_time") {
        if (query.period === "all") return user.total_seconds;
        let sum = 0;
        for (const [day, bucket] of user.days) {
          if (day >= since) sum += bucket.seconds;
        }
        return sum;
      }
      if (query.period === "all") return user.counters[query.metric] ?? 0;
      let sum = 0;
      for (const [day, bucket] of user.days) {
        if (day >= since) sum += bucket.counters[query.metric] ?? 0;
      }
      return sum;
    };

    let entries = pool.map((user) => ({ ...publicUser(user), value: value(user) }));
    if (query.period !== "all") {
      entries = entries.filter((entry) => entry.value > 0);
    }
    entries.sort((a, b) => b.value - a.value || (a.handle < b.handle ? -1 : 1));
    return { entries: entries.slice(0, query.limit), at };
  }

  async flush(): Promise<void> {
    await this.ensureHydrated();
    if (this.dirty.size === 0) {
      await this.prune();
      return;
    }

    const handles = this.dirty;
    const days = this.dirtyDays;
    this.dirty = new Set();
    this.dirtyDays = new Set();

    const users: {
      handle: string;
      total_seconds: number;
      last_seen_at: number | null;
      counters: Record<string, number>;
    }[] = [];
    const usage: {
      handle: string;
      day: string;
      seconds: number;
      counters: Record<string, number>;
    }[] = [];
    for (const handle of handles) {
      const user = this.users.get(handle);
      if (!user) continue;
      users.push({
        handle,
        total_seconds: user.total_seconds,
        last_seen_at: user.last_seen_at,
        counters: user.counters,
      });
    }
    for (const key of days) {
      const [handle, day] = key.split("\n") as [string, string];
      const bucket = this.users.get(handle)?.days.get(day);
      if (bucket !== undefined) {
        usage.push({ handle, day, seconds: bucket.seconds, counters: bucket.counters });
      }
    }

    try {
      await this.db.flushUsage({ users, usage, chunk: FLUSH_CHUNK });
    } catch (err) {
      for (const handle of handles) this.dirty.add(handle);
      for (const key of days) this.dirtyDays.add(key);
      throw err;
    }

    for (const row of users) {
      this.journal.exec(
        "DELETE FROM pending WHERE handle = ?1 AND total_seconds <= ?2",
        row.handle,
        row.total_seconds,
      );
    }
    await this.prune();
  }

  private async prune(): Promise<void> {
    const at = this.now();
    const today = utcDay(at);
    if (today === this.lastPruneDay) {
      return;
    }
    this.lastPruneDay = today;
    this.journal.exec("DELETE FROM pings WHERE at < ?1", at - PING_TTL_SECONDS);
    const memoryCutoff = utcDay(at - (MEMORY_DAYS - 1) * 86400);
    for (const user of this.users.values()) {
      for (const day of user.days.keys()) {
        if (day < memoryCutoff) user.days.delete(day);
      }
    }
    await this.db.pruneUsageDays(utcDay(at - D1_RETENTION_DAYS * 86400));
  }
}

export { isError };

export const createHub = (
  d1: D1Database,
  journal: Journal,
  requestFlush: () => void | Promise<void>,
): HubCore => new HubCore(createDb(d1), journal, requestFlush);
