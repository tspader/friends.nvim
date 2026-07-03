local config = require("friends.config")

local M = {}

local timer = nil
local cached_line = ""
local cached_users = {}

local rebuild = function()
  local opts = config.options.statusline
  local by_handle = {}
  for _, user in ipairs(cached_users) do
    by_handle[user.handle] = user
  end
  local parts = {}
  for _, handle in ipairs(require("friends.roster").all()) do
    local user = by_handle[handle]
    local icon = (user and user.active) and opts.active or opts.idle
    if opts.names then
      local name = (user and user.display_name) or handle
      table.insert(parts, icon .. " " .. name)
    else
      table.insert(parts, icon)
    end
  end
  cached_line = table.concat(parts, opts.separator)
end

M.refresh = function(cb)
  local handles = require("friends.roster").all()
  if #handles == 0 then
    cached_users = {}
    rebuild()
    if cb then
      cb()
    end
    return
  end
  require("friends.api").status(handles, function(data)
    if data and data.users then
      cached_users = data.users
    end
    rebuild()
    if cb then
      cb()
    end
  end)
end

M.users = function()
  return cached_users
end

M.statusline = function()
  return cached_line
end

M.start = function()
  if timer or config.options.status_interval <= 0 then
    return
  end
  M.refresh()
  timer = vim.uv.new_timer()
  local interval = config.options.status_interval * 1000
  timer:start(interval, interval, vim.schedule_wrap(M.refresh))
end

M.stop = function()
  if not timer then
    return
  end
  timer:stop()
  timer:close()
  timer = nil
end

return M
