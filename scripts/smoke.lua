-- End-to-end smoke test driving the plugin against a local backend.
-- Run via scripts/smoke.sh (it starts the backend and sandboxes XDG dirs).

local url = vim.env.FRIENDS_URL or "http://127.0.0.1:8787/api"
local failed = 0

local check = function(name, ok, detail)
  if ok then
    print("PASS " .. name)
  else
    failed = failed + 1
    print("FAIL " .. name .. (detail and (" — " .. detail) or ""))
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

require("friends").setup({ url = url, heartbeat_interval = 1, status_interval = 0 })
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
  api.heartbeat(FRIEND, TOKEN, 60, nil, cb)
end)
check("heartbeat credits time", hb and hb.total_seconds == 60, vim.inspect(hb))

local _, limited = await(function(cb)
  api.heartbeat(FRIEND, TOKEN, 10, nil, cb)
end)
check("rapid heartbeats are rate limited", limited == 429, tostring(limited))

local roster = require("friends.roster")
roster.add(FRIEND)
vim.wait(5000, function()
  return vim.tbl_contains(roster.all(), FRIEND)
end)
check("registered friend is added", vim.tbl_contains(roster.all(), FRIEND))

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
  api.leaderboard({ period = "week", limit = 10 }, cb)
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
  return vim.bo.filetype == "friends"
end)
local target
for i, l in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do
  if l:find("Smokey", 1, true) then
    target = i
  end
end
check("leaderboard row shows friend", target ~= nil)
if target then
  vim.api.nvim_win_set_cursor(0, { target, 0 })
  vim.api.nvim_feedkeys("a", "tx", false)
  vim.wait(5000, function()
    return vim.tbl_contains(roster.all(), FRIEND)
  end)
  check("follow from leaderboard", vim.tbl_contains(roster.all(), FRIEND))
  vim.cmd("close")
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
os.exit(0)
