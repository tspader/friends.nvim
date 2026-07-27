local config = require("friends.config")

local M = {}

M.last_error = nil

local MAX_HANDLES = 64

local capped = function(handles)
  if handles and #handles > MAX_HANDLES then
    return vim.list_slice(handles, 1, MAX_HANDLES)
  end
  return handles
end

local request = function(method, path, body, cb)
  local args = {
    "curl",
    "-sS",
    "--max-time",
    tostring(config.options.request_timeout / 1000),
    "-X",
    method,
    "-H",
    "content-type: application/json",
    "-H",
    "accept: application/json",
    "-w",
    "\n%{http_code}",
    config.options.url .. path,
  }
  if body ~= nil then
    table.insert(args, "-d")
    table.insert(args, vim.json.encode(body))
  end
  vim.system(args, { text = true }, function(out)
    vim.schedule(function()
      if out.code ~= 0 then
        M.last_error = vim.trim(out.stderr or "curl failed")
        cb(nil, 0)
        return
      end
      local payload, status = (out.stdout or ""):match("^(.*)\n(%d+)%s*$")
      status = tonumber(status) or 0
      local ok, decoded =
        pcall(vim.json.decode, payload or "", { luanil = { object = true, array = true } })
      if status < 200 or status >= 300 or not ok then
        local body = ok and type(decoded) == "table" and decoded or nil
        M.last_error = (body and body.error)
          or string.format("%s %s -> %d", method, path, status)
        cb(nil, status, body and body.code or nil)
        return
      end
      M.last_error = nil
      cb(decoded, status)
    end)
  end)
end

M.register = function(handle, token, display_name, cb)
  local body = { token = token }
  if display_name ~= nil then
    body.display_name = display_name
  end
  request("PUT", "/v1/users/" .. handle, body, cb or function() end)
end

M.heartbeat = function(handle, token, seconds, counters, handles, cb)
  local body = { token = token, seconds = seconds }
  if counters and next(counters) then
    body.counters = counters
  end
  handles = capped(handles)
  if handles and #handles > 0 then
    body.handles = handles
  end
  request("POST", "/v1/users/" .. handle .. "/heartbeat", body, cb or function() end)
end

M.delete = function(handle, token, cb)
  request("DELETE", "/v1/users/" .. handle, { token = token }, cb or function() end)
end

M.status = function(handles, cb)
  request("GET", "/v1/users?handles=" .. table.concat(capped(handles), ","), nil, cb)
end

M.leaderboard = function(opts, cb)
  local query = "?period=" .. opts.period .. "&metric=" .. opts.metric .. "&limit=" .. opts.limit
  if opts.handles then
    query = query .. "&handles=" .. table.concat(opts.handles, ",")
  end
  request("GET", "/v1/leaderboard" .. query, nil, cb)
end

M.send_ping = function(handle, token, to, message, cb)
  local body = { token = token, to = to }
  if message then
    body.message = message
  end
  request("POST", "/v1/users/" .. handle .. "/ping", body, cb or function() end)
end

-- Blocking; only for :checkhealth.
M.healthcheck = function()
  local out = vim
    .system({ "curl", "-fsS", "--max-time", "2", config.options.url }, { text = true })
    :wait()
  return out.code == 0
end

return M
