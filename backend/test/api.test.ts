import { apiTests } from "./executor";

// 2026-01-10T12:00:00Z
const NOON = 1768046400;
const DAY = 86400;

const OTTER = { handle: "brave-otter-42", token: "otter-token-0001" };
const LYNX = { handle: "wild-lynx-90", token: "lynx-token-00001" };

const register = (u: typeof OTTER, extra?: object, now?: number) => ({
  method: "PUT" as const,
  path: `/api/v1/users/${u.handle}`,
  body: { token: u.token, ...extra },
  now,
});

const heartbeat = (u: typeof OTTER, seconds: number, now?: number) => ({
  method: "POST" as const,
  path: `/api/v1/users/${u.handle}/heartbeat`,
  body: { token: u.token, seconds },
  now,
});

apiTests({
  "register: creates a user": {
    request: register(OTTER),
    expect: {
      status: 200,
      body: {
        handle: OTTER.handle,
        display_name: null,
        total_seconds: 0,
        last_seen_at: null,
        active: false,
      },
    },
  },

  "register: sets display name": {
    request: register(OTTER, { display_name: "Thomas" }),
    expect: { status: 200, body: { handle: OTTER.handle, display_name: "Thomas" } },
  },

  "register: is idempotent and keeps display name when omitted": {
    setup: [register(OTTER, { display_name: "Thomas" }, NOON), heartbeat(OTTER, 60, NOON + 60)],
    request: register(OTTER, {}, NOON + 120),
    expect: {
      status: 200,
      body: { handle: OTTER.handle, display_name: "Thomas", total_seconds: 60 },
    },
  },

  "register: rejects a taken handle with the wrong token": {
    setup: [register(OTTER)],
    request: {
      method: "PUT",
      path: `/api/v1/users/${OTTER.handle}`,
      body: { token: "someone-elses-token" },
    },
    expect: { status: 409, body: { error: "handle taken" } },
  },

  "register: rejects missing token": {
    request: { method: "PUT", path: `/api/v1/users/${OTTER.handle}`, body: {} },
    expect: { status: 400, body: { error: "invalid token" } },
  },

  "register: rejects invalid handle": {
    request: { method: "PUT", path: "/api/v1/users/Not-Valid!", body: { token: OTTER.token } },
    expect: { status: 400, body: { error: "invalid handle" } },
  },

  "register: rejects too-short handle": {
    request: { method: "PUT", path: "/api/v1/users/ab", body: { token: OTTER.token } },
    expect: { status: 400, body: { error: "invalid handle" } },
  },

  "register: rejects non-string display name": {
    request: register(OTTER, { display_name: 42 }),
    expect: { status: 400, body: { error: "invalid display_name" } },
  },

  "heartbeat: accumulates seconds": {
    setup: [register(OTTER, {}, NOON), heartbeat(OTTER, 60, NOON + 60)],
    request: heartbeat(OTTER, 45, NOON + 120),
    expect: { status: 200, body: { handle: OTTER.handle, total_seconds: 105, active: true } },
  },

  "heartbeat: auto-registers unknown handle": {
    request: heartbeat(LYNX, 30),
    expect: { status: 200, body: { handle: LYNX.handle, total_seconds: 30, active: true } },
  },

  "heartbeat: rejects the wrong token": {
    setup: [register(OTTER)],
    request: {
      method: "POST",
      path: `/api/v1/users/${OTTER.handle}/heartbeat`,
      body: { token: "someone-elses-token", seconds: 60 },
    },
    expect: { status: 403, body: { error: "handle taken" } },
  },

  "heartbeat: rate limits heartbeats closer than 15s": {
    setup: [heartbeat(OTTER, 60, NOON)],
    request: heartbeat(OTTER, 10, NOON + 10),
    expect: { status: 429 },
  },

  "heartbeat: credits at most wall-clock time since the last one": {
    setup: [heartbeat(OTTER, 300, NOON)],
    request: heartbeat(OTTER, 300, NOON + 60),
    expect: { status: 200, body: { total_seconds: 360 } },
  },

  "heartbeat: rejects missing token": {
    request: {
      method: "POST",
      path: `/api/v1/users/${LYNX.handle}/heartbeat`,
      body: { seconds: 60 },
    },
    expect: { status: 400, body: { error: "invalid token" } },
  },

  "heartbeat: rejects zero seconds": {
    request: heartbeat(LYNX, 0),
    expect: { status: 400 },
  },

  "heartbeat: rejects seconds over the cap": {
    request: heartbeat(LYNX, 301),
    expect: { status: 400 },
  },

  "heartbeat: rejects fractional seconds": {
    request: heartbeat(LYNX, 1.5),
    expect: { status: 400 },
  },

  "heartbeat: rejects missing body": {
    request: { method: "POST", path: `/api/v1/users/${LYNX.handle}/heartbeat` },
    expect: { status: 400 },
  },

  "status: reports recent heartbeat as active": {
    setup: [heartbeat(LYNX, 60, NOON)],
    request: { method: "GET", path: `/api/v1/users?handles=${LYNX.handle}`, now: NOON + 60 },
    expect: {
      status: 200,
      body: {
        users: [{ handle: LYNX.handle, total_seconds: 60, last_seen_at: NOON, active: true }],
      },
    },
  },

  "status: reports stale heartbeat as inactive": {
    setup: [heartbeat(LYNX, 60, NOON)],
    request: { method: "GET", path: `/api/v1/users?handles=${LYNX.handle}`, now: NOON + 121 },
    expect: { status: 200, body: { users: [{ handle: LYNX.handle, active: false }] } },
  },

  "status: returns users in requested order, skipping unknown handles": {
    setup: [register(OTTER), register(LYNX)],
    request: {
      method: "GET",
      path: `/api/v1/users?handles=${LYNX.handle},no-such-user-00,${OTTER.handle}`,
    },
    expect: {
      status: 200,
      body: { users: [{ handle: LYNX.handle }, { handle: OTTER.handle }] },
    },
  },

  "status: rejects empty handle list": {
    request: { method: "GET", path: "/api/v1/users?handles=" },
    expect: { status: 400 },
  },

  "status: does not leak tokens": {
    setup: [register(OTTER)],
    request: { method: "GET", path: `/api/v1/users?handles=${OTTER.handle}` },
    expect: { status: 200, notContains: "token" },
  },

  "leaderboard: ranks all-time totals": {
    setup: [
      heartbeat({ handle: "slow-snail-01", token: "snail-token-0001" }, 60),
      heartbeat({ handle: "fast-hare-02", token: "hare-token-00001" }, 240),
      heartbeat({ handle: "mid-fox-03", token: "fox-token-000001" }, 120),
    ],
    request: { method: "GET", path: "/api/v1/leaderboard" },
    expect: {
      status: 200,
      body: {
        period: "all",
        entries: [
          { rank: 1, handle: "fast-hare-02", seconds: 240 },
          { rank: 2, handle: "mid-fox-03", seconds: 120 },
          { rank: 3, handle: "slow-snail-01", seconds: 60 },
        ],
      },
    },
  },

  "leaderboard: breaks ties by handle": {
    setup: [
      heartbeat({ handle: "zed-zebra-02", token: "zebra-token-0001" }, 60),
      heartbeat({ handle: "ace-asp-01", token: "asp-token-000001" }, 60),
    ],
    request: { method: "GET", path: "/api/v1/leaderboard" },
    expect: {
      status: 200,
      body: {
        entries: [
          { rank: 1, handle: "ace-asp-01" },
          { rank: 2, handle: "zed-zebra-02" },
        ],
      },
    },
  },

  "leaderboard: today excludes yesterday's usage": {
    setup: [
      heartbeat({ handle: "slow-snail-01", token: "snail-token-0001" }, 300, NOON - DAY),
      heartbeat({ handle: "slow-snail-01", token: "snail-token-0001" }, 60, NOON),
      heartbeat({ handle: "fast-hare-02", token: "hare-token-00001" }, 120, NOON),
    ],
    request: { method: "GET", path: "/api/v1/leaderboard?period=today", now: NOON },
    expect: {
      status: 200,
      body: {
        period: "today",
        entries: [
          { rank: 1, handle: "fast-hare-02", seconds: 120 },
          { rank: 2, handle: "slow-snail-01", seconds: 60 },
        ],
      },
    },
  },

  "leaderboard: week spans seven days and drops older usage": {
    setup: [
      heartbeat({ handle: "slow-snail-01", token: "snail-token-0001" }, 300, NOON - 7 * DAY),
      heartbeat({ handle: "slow-snail-01", token: "snail-token-0001" }, 60, NOON - 6 * DAY),
      heartbeat({ handle: "slow-snail-01", token: "snail-token-0001" }, 30, NOON),
    ],
    request: { method: "GET", path: "/api/v1/leaderboard?period=week", now: NOON },
    expect: {
      status: 200,
      body: {
        period: "week",
        entries: [{ rank: 1, handle: "slow-snail-01", seconds: 90 }],
      },
    },
  },

  "leaderboard: filters to the given handles": {
    setup: [
      heartbeat({ handle: "slow-snail-01", token: "snail-token-0001" }, 60),
      heartbeat({ handle: "fast-hare-02", token: "hare-token-00001" }, 240),
      heartbeat({ handle: "mid-fox-03", token: "fox-token-000001" }, 120),
    ],
    request: {
      method: "GET",
      path: "/api/v1/leaderboard?handles=slow-snail-01,mid-fox-03",
    },
    expect: {
      status: 200,
      body: {
        entries: [
          { rank: 1, handle: "mid-fox-03", seconds: 120 },
          { rank: 2, handle: "slow-snail-01", seconds: 60 },
        ],
      },
    },
  },

  "leaderboard: filters to the given handles within a period": {
    setup: [
      heartbeat({ handle: "slow-snail-01", token: "snail-token-0001" }, 60, NOON),
      heartbeat({ handle: "fast-hare-02", token: "hare-token-00001" }, 240, NOON),
    ],
    request: {
      method: "GET",
      path: "/api/v1/leaderboard?period=today&handles=slow-snail-01",
      now: NOON,
    },
    expect: {
      status: 200,
      body: { entries: [{ rank: 1, handle: "slow-snail-01", seconds: 60 }] },
    },
  },

  "leaderboard: respects limit": {
    setup: [
      heartbeat({ handle: "slow-snail-01", token: "snail-token-0001" }, 60),
      heartbeat({ handle: "fast-hare-02", token: "hare-token-00001" }, 240),
    ],
    request: { method: "GET", path: "/api/v1/leaderboard?limit=1" },
    expect: {
      status: 200,
      body: { entries: [{ rank: 1, handle: "fast-hare-02" }] },
    },
  },

  "leaderboard: rejects unknown period": {
    request: { method: "GET", path: "/api/v1/leaderboard?period=fortnight" },
    expect: { status: 400 },
  },

  "leaderboard: rejects non-integer limit": {
    request: { method: "GET", path: "/api/v1/leaderboard?limit=abc" },
    expect: { status: 400 },
  },
});
