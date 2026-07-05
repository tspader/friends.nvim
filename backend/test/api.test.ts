import { apiTests, type Step } from "./executor";

const NOON = 1768046400;
const DAY = 86400;

const OTTER = { handle: "brave-otter-42", token: "otter-token-0001" };
const LYNX = { handle: "wild-lynx-90", token: "lynx-token-00001" };
const SNAIL = { handle: "slow-snail-01", token: "snail-token-0001" };
const HARE = { handle: "fast-hare-02", token: "hare-token-00001" };
const FOX = { handle: "mid-fox-03", token: "fox-token-000001" };

const register = (u: typeof OTTER, extra?: object, now?: number): Step => ({
  method: "PUT" as const,
  path: `/api/v1/users/${u.handle}`,
  body: { token: u.token, ...extra },
  now,
});

const heartbeat = (u: typeof OTTER, seconds: number, now?: number): Step => ({
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

  "register: rejects control characters in display_name": {
    request: register(OTTER, { display_name: "evil\u001b[2Jname" }),
    expect: { status: 400, body: { error: "invalid display_name" } },
  },

  "register: rejects whitespace-only display_name": {
    request: register(OTTER, { display_name: "   " }),
    expect: { status: 400, body: { error: "invalid display_name" } },
  },

  "register: trims display_name": {
    request: register(OTTER, { display_name: "  Thomas  " }),
    expect: { status: 200, body: { display_name: "Thomas" } },
  },

  "register: caps registrations per address": {
    setup: Array.from({ length: 20 }, (_, i) =>
      register({ handle: `sybil-user-${String(i).padStart(2, "0")}`, token: OTTER.token }),
    ),
    request: register({ handle: "sybil-user-20", token: OTTER.token }),
    expect: { status: 429 },
  },

  "requests: reject oversized bodies": {
    request: {
      method: "PUT",
      path: `/api/v1/users/${OTTER.handle}`,
      body: { token: OTTER.token },
      headers: { "content-length": "99999" },
    },
    expect: { status: 413 },
  },

  "heartbeat: accumulates seconds": {
    setup: [register(OTTER, {}, NOON), heartbeat(OTTER, 60, NOON + 60)],
    request: heartbeat(OTTER, 45, NOON + 120),
    expect: { status: 200, body: { handle: OTTER.handle, total_seconds: 105, active: true } },
  },

  "heartbeat: 404s an unknown handle": {
    request: heartbeat(LYNX, 30),
    expect: { status: 404, body: { error: "not found" } },
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
    setup: [register(OTTER, {}, NOON), heartbeat(OTTER, 60, NOON)],
    request: heartbeat(OTTER, 10, NOON + 10),
    expect: { status: 429 },
  },

  "heartbeat: credits at most wall-clock time since the last one": {
    setup: [register(OTTER, {}, NOON), heartbeat(OTTER, 300, NOON)],
    request: heartbeat(OTTER, 300, NOON + 60),
    expect: { status: 200, body: { total_seconds: 360 } },
  },

  "heartbeat: returns friend statuses when handles are sent": {
    setup: [
      register(OTTER, {}, NOON),
      register(LYNX, {}, NOON),
      heartbeat(LYNX, 60, NOON),
    ],
    request: {
      method: "POST",
      path: `/api/v1/users/${OTTER.handle}/heartbeat`,
      body: { token: OTTER.token, seconds: 60, handles: [LYNX.handle, "no-such-user-00"] },
      now: NOON + 60,
    },
    expect: {
      status: 200,
      body: {
        handle: OTTER.handle,
        total_seconds: 60,
        users: [{ handle: LYNX.handle, total_seconds: 60, active: true }],
      },
    },
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

  "delete: removes the user with the right token": {
    setup: [register(OTTER, {}, NOON), heartbeat(OTTER, 60, NOON)],
    request: {
      method: "DELETE",
      path: `/api/v1/users/${OTTER.handle}`,
      body: { token: OTTER.token },
    },
    expect: { status: 200, body: { ok: true } },
  },

  "delete: leaves no trace behind": {
    setup: [
      register(OTTER, {}, NOON),
      heartbeat(OTTER, 60, NOON),
      { method: "DELETE", path: `/api/v1/users/${OTTER.handle}`, body: { token: OTTER.token } },
    ],
    request: { method: "GET", path: `/api/v1/users?handles=${OTTER.handle}` },
    expect: { status: 200, body: { users: [] } },
  },

  "delete: frees the handle for a new owner": {
    setup: [
      register(OTTER),
      { method: "DELETE", path: `/api/v1/users/${OTTER.handle}`, body: { token: OTTER.token } },
    ],
    request: {
      method: "PUT",
      path: `/api/v1/users/${OTTER.handle}`,
      body: { token: "a-brand-new-token" },
    },
    expect: { status: 200, body: { handle: OTTER.handle } },
  },

  "delete: rejects the wrong token": {
    setup: [register(OTTER)],
    request: {
      method: "DELETE",
      path: `/api/v1/users/${OTTER.handle}`,
      body: { token: "someone-elses-token" },
    },
    expect: { status: 403, body: { error: "handle taken" } },
  },

  "delete: 404s an unknown handle": {
    request: {
      method: "DELETE",
      path: `/api/v1/users/${OTTER.handle}`,
      body: { token: OTTER.token },
    },
    expect: { status: 404 },
  },

  "delete: rejects missing token": {
    setup: [register(OTTER)],
    request: { method: "DELETE", path: `/api/v1/users/${OTTER.handle}`, body: {} },
    expect: { status: 400, body: { error: "invalid token" } },
  },

  "status: reports recent heartbeat as active": {
    setup: [register(LYNX, {}, NOON), heartbeat(LYNX, 60, NOON)],
    request: { method: "GET", path: `/api/v1/users?handles=${LYNX.handle}`, now: NOON + 60 },
    expect: {
      status: 200,
      body: {
        users: [{ handle: LYNX.handle, total_seconds: 60, last_seen_at: NOON, active: true }],
      },
    },
  },

  "status: reports stale heartbeat as inactive": {
    setup: [register(LYNX, {}, NOON), heartbeat(LYNX, 60, NOON)],
    request: { method: "GET", path: `/api/v1/users?handles=${LYNX.handle}`, now: NOON + 301 },
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
      register(SNAIL, {}, NOON),
      register(HARE, {}, NOON),
      register(FOX, {}, NOON),
      heartbeat(SNAIL, 60, NOON),
      heartbeat(HARE, 240, NOON),
      heartbeat(FOX, 120, NOON),
    ],
    request: { method: "GET", path: "/api/v1/leaderboard" },
    expect: {
      status: 200,
      body: {
        period: "all",
        entries: [
          { rank: 1, handle: HARE.handle, seconds: 240 },
          { rank: 2, handle: FOX.handle, seconds: 120 },
          { rank: 3, handle: SNAIL.handle, seconds: 60 },
        ],
      },
    },
  },

  "leaderboard: breaks ties by handle": {
    setup: [
      register({ handle: "zed-zebra-02", token: "zebra-token-0001" }, {}, NOON),
      register({ handle: "ace-asp-01", token: "asp-token-000001" }, {}, NOON),
      heartbeat({ handle: "zed-zebra-02", token: "zebra-token-0001" }, 60, NOON),
      heartbeat({ handle: "ace-asp-01", token: "asp-token-000001" }, 60, NOON),
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
      register(SNAIL, {}, NOON - DAY),
      register(HARE, {}, NOON - DAY),
      heartbeat(SNAIL, 300, NOON - DAY),
      heartbeat(SNAIL, 60, NOON),
      heartbeat(HARE, 120, NOON),
    ],
    request: { method: "GET", path: "/api/v1/leaderboard?period=today", now: NOON },
    expect: {
      status: 200,
      body: {
        period: "today",
        entries: [
          { rank: 1, handle: HARE.handle, seconds: 120 },
          { rank: 2, handle: SNAIL.handle, seconds: 60 },
        ],
      },
    },
  },

  "leaderboard: week spans seven days and drops older usage": {
    setup: [
      register(SNAIL, {}, NOON - 7 * DAY),
      heartbeat(SNAIL, 300, NOON - 7 * DAY),
      heartbeat(SNAIL, 60, NOON - 6 * DAY),
      heartbeat(SNAIL, 30, NOON),
    ],
    request: { method: "GET", path: "/api/v1/leaderboard?period=week", now: NOON },
    expect: {
      status: 200,
      body: {
        period: "week",
        entries: [{ rank: 1, handle: SNAIL.handle, seconds: 90 }],
      },
    },
  },

  "leaderboard: filters to the given handles": {
    setup: [
      register(SNAIL, {}, NOON),
      register(HARE, {}, NOON),
      register(FOX, {}, NOON),
      heartbeat(SNAIL, 60, NOON),
      heartbeat(HARE, 240, NOON),
      heartbeat(FOX, 120, NOON),
    ],
    request: {
      method: "GET",
      path: `/api/v1/leaderboard?handles=${SNAIL.handle},${FOX.handle}`,
    },
    expect: {
      status: 200,
      body: {
        entries: [
          { rank: 1, handle: FOX.handle, seconds: 120 },
          { rank: 2, handle: SNAIL.handle, seconds: 60 },
        ],
      },
    },
  },

  "leaderboard: filters to the given handles within a period": {
    setup: [
      register(SNAIL, {}, NOON),
      register(HARE, {}, NOON),
      heartbeat(SNAIL, 60, NOON),
      heartbeat(HARE, 240, NOON),
    ],
    request: {
      method: "GET",
      path: `/api/v1/leaderboard?period=today&handles=${SNAIL.handle}`,
      now: NOON,
    },
    expect: {
      status: 200,
      body: { entries: [{ rank: 1, handle: SNAIL.handle, seconds: 60 }] },
    },
  },

  "leaderboard: respects limit": {
    setup: [
      register(SNAIL, {}, NOON),
      register(HARE, {}, NOON),
      heartbeat(SNAIL, 60, NOON),
      heartbeat(HARE, 240, NOON),
    ],
    request: { method: "GET", path: "/api/v1/leaderboard?limit=1" },
    expect: {
      status: 200,
      body: { entries: [{ rank: 1, handle: HARE.handle }] },
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
