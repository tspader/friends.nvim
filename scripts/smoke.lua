-- End-to-end smoke test driving the plugin against a local backend.
-- Run via scripts/smoke.sh (it starts the backend and sandboxes XDG dirs).

local url = vim.env.FRIENDS_URL or "http://127.0.0.1:8787/api"
local failed = 0

local colored = function(color, text)
  local codes = { green = "32", red = "31" }
  return "\27[" .. codes[color] .. "m" .. text .. "\27[0m"
end

local check = function(name, ok, detail)
  if ok then
    io.write(name .. "..." .. colored("green", "ok") .. "\n")
  else
    failed = failed + 1
    io.write(name .. "..." .. colored("red", "fail") .. (detail and (" — " .. detail) or "") .. "\n")
  end
end

local api = require("friends.api")
local await = function(fn)
  local out, code, done
  fn(function(data, status)
    out = data
    code = status
    done = true
  end)
  vim.wait(5000, function()
    return done
  end)
  return out, code
end

require("friends").setup({ url = url, status_interval = 0, ws = { enabled = false } })
require("friends").start()
local me = require("friends").handle()
check("identity generated", type(me) == "string" and #me > 0, tostring(me))

local FRIEND = "smoke-friend-01"
local TOKEN = "smoke-token-0001"

local reg = await(function(cb)
  api.register(FRIEND, TOKEN, "Smokey", cb)
end)
check("register friend", reg and reg.handle == FRIEND, tostring(api.last_error))

local _, conflict = await(function(cb)
  api.register(FRIEND, "someone-elses-key", nil, cb)
end)
check("wrong token cannot take a handle", conflict == 409, tostring(conflict))

local hb = await(function(cb)
  api.heartbeat(FRIEND, TOKEN, 60, { keys_pressed = 123 }, nil, cb)
end)
check("heartbeat credits time", hb and hb.total_seconds == 60, vim.inspect(hb))
check(
  "heartbeat counters round-trip",
  hb and hb.counters and hb.counters.keys_pressed == 123,
  vim.inspect(hb and hb.counters)
)

local _, limited = await(function(cb)
  api.heartbeat(FRIEND, TOKEN, 10, nil, nil, cb)
end)
check("rapid heartbeats are rate limited", limited == 429, tostring(limited))

local my_identity = require("friends.identity").get()

local sent = await(function(cb)
  api.send_ping(FRIEND, TOKEN, me, "hello from smoke test", cb)
end)
check("ping accepted", sent and sent.ok == true, vim.inspect(sent))

local _, cooldown_status = await(function(cb)
  api.send_ping(FRIEND, TOKEN, me, nil, cb)
end)
check("rapid pings from same sender are rate limited", cooldown_status == 429, tostring(cooldown_status))

local _, unknown_status = await(function(cb)
  api.send_ping(FRIEND, TOKEN, "nobody-here-00", nil, cb)
end)
check("ping to unregistered handle 404s", unknown_status == 404, tostring(unknown_status))

local delivered = await(function(cb)
  api.heartbeat(me, my_identity.token, 30, nil, nil, cb)
end)
check(
  "ping rides the heartbeat response",
  delivered
    and delivered.pings
    and #delivered.pings == 1
    and delivered.pings[1].from == FRIEND
    and delivered.pings[1].message == "hello from smoke test",
  vim.inspect(delivered and delivered.pings)
)

local roster = require("friends.roster")
roster.add(FRIEND)
vim.wait(5000, function()
  return vim.tbl_contains(roster.all(), FRIEND)
end)
check("registered friend is added", vim.tbl_contains(roster.all(), FRIEND))

local SECOND_FRIEND = "smoke-friend-02"
local SECOND_TOKEN = "smoke-token-0002"
local reg2 = await(function(cb)
  api.register(SECOND_FRIEND, SECOND_TOKEN, "Smokey", cb)
end)
check("register second friend", reg2 and reg2.handle == SECOND_FRIEND, tostring(api.last_error))
roster.add(SECOND_FRIEND)
vim.wait(5000, function()
  return vim.tbl_contains(roster.all(), SECOND_FRIEND)
end)

local status = require("friends.status")
status.refresh()
vim.wait(5000, function()
  return status.display_name(FRIEND) == "Smokey" and status.display_name(SECOND_FRIEND) == "Smokey"
end)

local notify_msg
local orig_notify = vim.notify
vim.notify = function(msg)
  notify_msg = msg
end
vim.cmd("Friends ping Smokey hi")
vim.wait(500)
vim.notify = orig_notify
check(
  "ambiguous display name rejected",
  notify_msg ~= nil
    and notify_msg:find("matches multiple friends", 1, true) ~= nil
    and notify_msg:find(FRIEND, 1, true) ~= nil
    and notify_msg:find(SECOND_FRIEND, 1, true) ~= nil,
  tostring(notify_msg)
)

roster.remove(SECOND_FRIEND)
vim.wait(5000, function()
  return not vim.tbl_contains(roster.all(), SECOND_FRIEND)
end)

notify_msg = nil
vim.notify = function(msg)
  notify_msg = msg
end
vim.cmd("Friends ping Smokey unique name works")
vim.wait(5000, function()
  return notify_msg ~= nil
end)
vim.notify = orig_notify
check(
  "ping by unique display name resolves to the right handle",
  notify_msg == "friends.nvim: pinged " .. FRIEND,
  tostring(notify_msg)
)

local orig_display_name = require("friends.identity").display_name()
notify_msg = nil
vim.notify = function(msg)
  notify_msg = msg
end
vim.cmd("Friends name has a space")
vim.wait(200)
vim.notify = orig_notify
check(
  "display name with spaces rejected",
  notify_msg ~= nil and notify_msg:find("can't contain spaces", 1, true) ~= nil,
  tostring(notify_msg)
)
check(
  "rejected display name left unchanged",
  require("friends.identity").display_name() == orig_display_name,
  tostring(require("friends.identity").display_name())
)

local ping_ui = require("friends.ping")
local editor_floats = function()
  local out = {}
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    local cfg = vim.api.nvim_win_get_config(win)
    if cfg.relative == "editor" and cfg.zindex == 300 then
      table.insert(out, { win = win, cfg = cfg })
    end
  end
  return out
end

ping_ui.deliver({ { from = FRIEND, message = "a message, so two lines" }, { from = FRIEND } })
local floats = editor_floats()
check("ping popups rendered", #floats == 2, tostring(#floats))
check(
  "ping popup names the sender",
  (vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(floats[1].win), 0, -1, false)[1] or ""):find(
    "pinged you",
    1,
    true
  ) ~= nil,
  vim.inspect(vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(floats[1].win), 0, -1, false))
)

local claimed, doubled = {}, {}
for _, float in ipairs(floats) do
  for row = float.cfg.row - 1, float.cfg.row + float.cfg.height do
    if claimed[row] then
      table.insert(doubled, row)
    end
    claimed[row] = true
  end
end
check("stacked ping popups do not overlap", #doubled == 0, "rows " .. vim.inspect(doubled))

ping_ui.dismiss()
ping_ui.deliver({
  { from = FRIEND, message = string.rep("x", 200) },
  { from = FRIEND, message = string.rep("漢", 120) },
})
local overflow = {}
for _, float in ipairs(editor_floats()) do
  for _, line in ipairs(vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(float.win), 0, -1, false)) do
    if vim.fn.strdisplaywidth(line) > float.cfg.width then
      table.insert(overflow, line)
    end
  end
end
check("long ping message is truncated to the popup width", #overflow == 0, vim.inspect(overflow))

ping_ui.deliver({ { from = "nobody-here-00", message = "from a stranger" } })
check("ping from a non-friend is ignored", #editor_floats() == 2, tostring(#editor_floats()))

ping_ui.dismiss()
local burst = {}
for i = 1, 6 do
  table.insert(burst, { from = FRIEND, message = "burst " .. i })
end
ping_ui.deliver(burst)
check("a burst of pings is capped to a readable stack", #editor_floats() == 3, tostring(#editor_floats()))

ping_ui.dismiss()
check("dismiss closes every ping popup", #editor_floats() == 0, tostring(#editor_floats()))

roster.add("nobody-here-00")
vim.wait(1000)
check(
  "unregistered friend is not added",
  not vim.tbl_contains(roster.all(), "nobody-here-00"),
  vim.inspect(roster.all())
)

local status = await(function(cb)
  api.status({ FRIEND, "nobody-here-00" }, cb)
end)
check(
  "friend status active",
  status and #status.users == 1 and status.users[1].active == true,
  vim.inspect(status)
)

vim.api.nvim_feedkeys("jjkk", "tx", false)
vim.wait(2500)
local mine = await(function(cb)
  api.status({ me }, cb)
end)
check(
  "keypresses tracked as activity",
  mine and mine.users[1] and (mine.users[1].total_seconds or 0) > 0,
  vim.inspect(mine)
)

local refreshed = false
require("friends.status").refresh(function()
  refreshed = true
end)
vim.wait(5000, function()
  return refreshed
end)
local line = require("friends").statusline()
check(
  "statusline shows highlighted active dot",
  line:find("%#FriendsActive#●", 1, true) ~= nil,
  "'" .. line .. "'"
)
check(
  "plain statusline has no escapes",
  require("friends").statusline({ hl = false }) == "●",
  "'" .. require("friends").statusline({ hl = false }) .. "'"
)
local parts = require("friends.status").parts()
check("statusline parts for lualine", #parts == 1 and parts[1].active == true, vim.inspect(parts))

local board = await(function(cb)
  api.leaderboard({ period = "week", metric = "active_time", limit = 10 }, cb)
end)
check("leaderboard has entries", board and board.entries and #board.entries >= 2, vim.inspect(board))

local mine_entry
for _, entry in ipairs((board and board.entries) or {}) do
  if entry.handle == me then
    mine_entry = entry
  end
end
check(
  "json null decodes to nil, not vim.NIL",
  mine_entry ~= nil and mine_entry.display_name == nil,
  vim.inspect(mine_entry)
)

roster.remove(FRIEND)
require("friends.ui").leaderboard()
vim.wait(5000, function()
  if vim.bo.filetype ~= "friends" then
    return false
  end
  local first = vim.api.nvim_buf_get_lines(0, 0, 1, false)[1] or ""
  return not first:find("fetching", 1, true)
end)
local target
for i, l in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do
  if l:find("Smokey", 1, true) then
    target = i
  end
end
check("leaderboard row shows friend", target ~= nil)

local float_title = function()
  local title = vim.api.nvim_win_get_config(0).title or {}
  local text = ""
  for _, chunk in ipairs(title) do
    text = text .. chunk[1]
  end
  return text
end

if target then
  vim.api.nvim_win_set_cursor(0, { target, 0 })
  vim.api.nvim_feedkeys("a", "tx", false)
  vim.wait(5000, function()
    return vim.tbl_contains(roster.all(), FRIEND)
  end)
  check("follow from leaderboard", vim.tbl_contains(roster.all(), FRIEND))

  local tab = vim.api.nvim_replace_termcodes("<Tab>", true, false, true)
  vim.api.nvim_feedkeys(tab, "tx", false)
  check("tab cycles period and retitles float", float_title():find("all", 1, true) ~= nil, float_title())
  vim.wait(5000, function()
    local first = vim.api.nvim_buf_get_lines(0, 0, 1, false)[1] or ""
    return not first:find("fetching", 1, true)
  end)
  local switched_shows_friend = false
  for _, l in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do
    if l:find("Smokey", 1, true) then
      switched_shows_friend = true
    end
  end
  check("switched leaderboard renders entries", switched_shows_friend)

  vim.api.nvim_feedkeys(tab, "tx", false)
  check("tab cycle wraps around", float_title():find("today", 1, true) ~= nil, float_title())

  vim.api.nvim_feedkeys("f", "tx", false)
  check(
    "f toggles friends-only and retitles",
    float_title():find("- friends", 1, true) ~= nil,
    float_title()
  )
  vim.wait(5000, function()
    local first = vim.api.nvim_buf_get_lines(0, 0, 1, false)[1] or ""
    return not first:find("fetching", 1, true)
  end)
  local friends_only_shows_friend = false
  for _, l in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do
    if l:find("Smokey", 1, true) then
      friends_only_shows_friend = true
    end
  end
  check("friends-only board renders entries", friends_only_shows_friend)

  vim.api.nvim_feedkeys("f", "tx", false)
  check("f toggles back to global", float_title():find("— friends", 1, true) == nil, float_title())
  vim.cmd("close")
end

local close_float = function()
  if vim.bo.filetype == "friends" then
    vim.cmd("close")
  end
end

vim.cmd("Friends board all")
vim.wait(5000, function()
  return vim.bo.filetype == "friends"
end)
check("Friends board opens requested period", float_title():find("all", 1, true) ~= nil, float_title())
close_float()

vim.cmd("Friends board active_time")
vim.wait(5000, function()
  return vim.bo.filetype == "friends"
end)
check("metric value accepted", vim.bo.filetype == "friends")
check("period persists across reopen", float_title():find("all", 1, true) ~= nil, float_title())
close_float()

local notify_msg
local orig_notify = vim.notify
vim.notify = function(msg)
  notify_msg = msg
end
vim.cmd("Friends board month")
vim.wait(500)
vim.notify = orig_notify
check(
  "invalid board value rejected",
  notify_msg ~= nil and notify_msg:find("invalid", 1, true) ~= nil,
  tostring(notify_msg)
)
check("invalid board value opens no float", vim.bo.filetype ~= "friends")

vim.cmd("Friends list")
vim.wait(5000, function()
  return vim.bo.filetype == "friends"
end)
local first_row = vim.api.nvim_buf_get_lines(0, 0, 1, false)[1] or ""
check(
  "list shows own handle first",
  first_row:find(me, 1, true) ~= nil and first_row:find("(you)", 1, true) ~= nil,
  "'" .. first_row .. "'"
)

local detail_has = function(text)
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    local b = vim.api.nvim_win_get_buf(w)
    for _, l in ipairs(vim.api.nvim_buf_get_lines(b, 0, -1, false)) do
      if l:find(text, 1, true) then
        return true
      end
    end
  end
  return false
end
vim.wait(5000, function()
  return detail_has("keys pressed")
end)
check("list detail shows tracked stats", detail_has("keys pressed"))
check("list detail shows last active", detail_has("last active"))
close_float()

local empty_roster_body = api.heartbeat_body(60, { keys_pressed = 1 }, {})
check(
  "heartbeat body omits an empty roster",
  empty_roster_body.handles == nil and empty_roster_body.seconds == 60,
  vim.inspect(empty_roster_body)
)
local capped_body = api.heartbeat_body(60, nil, (function()
  local many = {}
  for i = 1, 70 do
    many[i] = ("friend-%02d-xx"):format(i)
  end
  return many
end)())
check(
  "heartbeat body caps an over-long roster",
  capped_body.handles ~= nil and #capped_body.handles == 64,
  tostring(capped_body.handles and #capped_body.handles)
)
check("heartbeat body omits empty counters", api.heartbeat_body(60, {}, nil).counters == nil)

local socket = require("friends.socket")
if vim.fn.executable("websocat") ~= 1 then
  io.write("live connection checks..." .. colored("green", "skipped") .. " (websocat not installed)\n")
else
  local ws_identity = require("friends.identity")
  require("friends").setup({ ws = { enabled = true } })
  socket.start()
  check("live connection comes up", vim.wait(10000, socket.is_ready, 50), socket.status())

  local WS_USER = "smoke-wsuser-01"
  local WS_TOKEN = "smoke-wstoken-01"
  local ws_reg = await(function(cb)
    api.register(WS_USER, WS_TOKEN, nil, cb)
  end)
  check("register a handle for the socket", ws_reg and ws_reg.handle == WS_USER, tostring(api.last_error))

  local ws_claimed
  ws_identity.claim(WS_USER, WS_TOKEN, function(ok)
    ws_claimed = ok
  end)
  vim.wait(5000, function()
    return ws_claimed ~= nil
  end)
  check("claim adopts the new identity", ws_claimed == true, tostring(ws_claimed))
  check(
    "socket reconnects under the claimed handle",
    vim.wait(10000, socket.is_ready, 50),
    socket.status()
  )

  local ack
  socket.send_heartbeat(
    vim.tbl_extend("force", { type = "heartbeat" }, api.heartbeat_body(60, { keys_pressed = 7 }, roster.all())),
    function(response)
      ack = response or false
    end
  )
  vim.wait(5000, function()
    return ack ~= nil
  end)
  check(
    "heartbeat over the socket credits time",
    type(ack) == "table"
      and ack.type == "heartbeat_ack"
      and ack.handle == WS_USER
      and ack.total_seconds == 60,
    vim.inspect(ack)
  )

  require("friends.tracker").stop()
  ping_ui.dismiss()
  local ws_ping = await(function(cb)
    api.send_ping(FRIEND, TOKEN, WS_USER, "live from the socket", cb)
  end)
  check("ping to a connected user accepted", ws_ping and ws_ping.ok == true, vim.inspect(ws_ping))
  check(
    "ping arrives live over the socket",
    vim.wait(5000, function()
      return #editor_floats() > 0
    end, 50),
    "no popup rendered"
  )
  ping_ui.dismiss()

  socket.stop()
  require("friends").setup({ ws = { enabled = false } })
  require("friends.tracker").start()
end

local identity = require("friends.identity")
local claim_result
identity.claim(FRIEND, "not-the-right-key", function(ok)
  claim_result = ok
end)
vim.wait(5000, function()
  return claim_result ~= nil
end)
check("claim with wrong token fails", claim_result == false, tostring(claim_result))

claim_result = nil
identity.claim(FRIEND, TOKEN, function(ok)
  claim_result = ok
end)
vim.wait(5000, function()
  return claim_result ~= nil
end)
check(
  "claim with right token adopts the identity",
  claim_result == true and require("friends").handle() == FRIEND,
  tostring(require("friends").handle())
)

if failed > 0 then
  print(("smoke: %d check(s) failed"):format(failed))
  os.exit(1)
end
print("smoke: all checks passed")
print("")
os.exit(0)
