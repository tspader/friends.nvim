local config = require("friends.config")

local M = {}

local job = nil
local ready = false
local backoff = 1
local stopped = true
local pending_cb = nil
local pending_timer = nil
local stdout_buf = ""
local warned_url = false
local last_error = nil

local generation = 0

local connect

local ws_url = function()
  local scheme, rest = config.options.url:match("^(https?)://(.+)$")
  if not scheme then
    if not warned_url then
      warned_url = true
      require("friends.util").notify(
        "url must start with http:// or https:// for the live connection; falling back to polling",
        vim.log.levels.WARN
      )
    end
    return nil
  end
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
  if decoded.type == "hello" then
    ready = true
    backoff = 1
    if decoded.handle and decoded.handle ~= require("friends.identity").get().handle then
      vim.schedule(M.restart)
    end
  elseif decoded.type == "ping" then
    require("friends.ping").deliver({ decoded })
  elseif decoded.type == "heartbeat_ack" or decoded.type == "error" then
    clear_pending(decoded)
  end
end

local schedule_retry = function(gen)
  if stopped or not M.enabled() then
    return
  end
  local delay = backoff
  backoff = math.min(backoff * 2, 60)
  vim.defer_fn(function()
    if gen == generation and not stopped then
      connect()
    end
  end, delay * 1000)
end

connect = function()
  if stopped then
    return
  end
  local url = ws_url()
  if not url then
    return
  end
  generation = generation + 1
  local gen = generation
  local identity = require("friends.identity").get()
  ready = false
  stdout_buf = ""
  job = vim.fn.jobstart({
    "websocat",
    "-t",
    "-E",
    "--ping-interval",
    "30",
    "--ping-timeout",
    "40",
    "-H=X-Friends-Handle: " .. identity.handle,
    "-H=X-Friends-Token: " .. identity.token,
    url,
  }, {
    on_stdout = function(_, data)
      if gen ~= generation then
        return
      end
      stdout_buf = stdout_buf .. (data[1] or "")
      for i = 2, #data do
        if stdout_buf ~= "" then
          on_line(stdout_buf)
        end
        stdout_buf = data[i]
      end
    end,
    on_stderr = function(_, data)
      if gen ~= generation then
        return
      end
      for _, line in ipairs(data) do
        if line ~= "" then
          last_error = line
        end
      end
    end,
    on_exit = function()
      if gen ~= generation then
        return
      end
      job = nil
      ready = false
      clear_pending(nil)
      schedule_retry(gen)
    end,
  })
  if job <= 0 then
    job = nil
    schedule_retry(gen)
  end
end

M.enabled = function()
  return config.options.ws.enabled and vim.fn.executable("websocat") == 1
end

M.is_ready = function()
  return job ~= nil and ready
end

M.status = function()
  if not config.options.ws.enabled then
    return "disabled"
  end
  if vim.fn.executable("websocat") ~= 1 then
    return "unavailable"
  end
  if not config.options.url:match("^https?://") then
    return "invalid_url"
  end
  if M.is_ready() then
    return "connected"
  end
  return "connecting"
end

M.last_error = function()
  return last_error
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
  generation = generation + 1
  ready = false
  if job then
    vim.fn.jobstop(job)
    job = nil
  end
  clear_pending(nil)
end

M.restart = function()
  if stopped then
    return
  end
  M.stop()
  M.start()
end

M.send_heartbeat = function(payload, cb)
  if not M.is_ready() then
    cb(nil)
    return
  end
  clear_pending(nil)
  pending_cb = cb
  pending_timer = vim.uv.new_timer()
  pending_timer:start(
    config.options.request_timeout,
    0,
    vim.schedule_wrap(function()
      clear_pending(nil)
    end)
  )
  vim.fn.chansend(job, vim.json.encode(payload) .. "\n")
end

return M
