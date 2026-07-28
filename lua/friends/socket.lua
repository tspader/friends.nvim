local config = require("friends.config")

local M = {}

local job = nil
local started_at = nil
local backoff = 1
local stopped = true
local pending_cb = nil
local pending_timer = nil

local connect

local ws_url = function()
  local scheme, rest = config.options.url:match("^(https?)://(.+)$")
  return (scheme == "https" and "wss" or "ws") .. "://" .. rest .. "/v1/ws"
end

local clear_pending = function(response)
  if pending_timer then
    pending_timer:stop()
    pending_timer:close()
    pending_timer = nil
  end
  if pending_cb then
    local cb = pending_cb
    pending_cb = nil
    cb(response)
  end
end

local on_line = function(line)
  local ok, decoded = pcall(vim.json.decode, line)
  if not ok or type(decoded) ~= "table" then
    return
  end
  if decoded.type == "ping" then
    require("friends.ping").deliver({ decoded })
  elseif decoded.type == "heartbeat_ack" or decoded.type == "error" then
    clear_pending(decoded)
  end
end

local schedule_retry = function()
  if stopped or not M.enabled() then
    return
  end
  local delay = backoff
  backoff = math.min(backoff * 2, 60)
  vim.defer_fn(connect, delay * 1000)
end

local on_exit = function()
  job = nil
  clear_pending(nil)
  if started_at and (vim.uv.now() - started_at) > 5000 then
    backoff = 1
  end
  schedule_retry()
end

connect = function()
  if stopped then
    return
  end
  local identity = require("friends.identity").get()
  started_at = vim.uv.now()
  job = vim.fn.jobstart({
    "websocat",
    "-t",
    "--ping-interval",
    "30",
    "--ping-timeout",
    "10",
    "-H",
    "X-Friends-Handle: " .. identity.handle,
    "-H",
    "X-Friends-Token: " .. identity.token,
    ws_url(),
  }, {
    on_stdout = function(_, data)
      for _, line in ipairs(data) do
        if line ~= "" then
          on_line(line)
        end
      end
    end,
    on_exit = on_exit,
  })
  if job <= 0 then
    job = nil
    schedule_retry()
  end
end

M.enabled = function()
  return config.options.ws.enabled and vim.fn.executable("websocat") == 1
end

M.is_ready = function()
  return job ~= nil
end

M.start = function()
  if not stopped then
    return
  end
  if not M.enabled() then
    return
  end
  stopped = false
  backoff = 1
  connect()
end

M.stop = function()
  stopped = true
  if job then
    vim.fn.jobstop(job)
    job = nil
  end
  clear_pending(nil)
end

M.send_heartbeat = function(payload, cb)
  if not job then
    cb(nil)
    return
  end
  pending_cb = cb
  pending_timer = vim.uv.new_timer()
  pending_timer:start(
    config.options.request_timeout,
    0,
    vim.schedule_wrap(function()
      clear_pending(nil)
    end)
  )
  local message = vim.tbl_extend("force", { type = "heartbeat" }, payload)
  vim.fn.chansend(job, vim.json.encode(message) .. "\n")
end

return M
