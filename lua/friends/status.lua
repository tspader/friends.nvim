local config = require("friends.config")

local M = {}

local timer = nil
local cached_parts = {}
local cached_plain = ""
local cached_native = ""
local cached_users = {}
local last_data = nil

local rebuild = function()
  local opts = config.options.statusline
  local by_handle = {}
  for _, user in ipairs(cached_users) do
    by_handle[user.handle] = user
  end
  cached_parts = {}
  for _, handle in ipairs(require("friends.roster").all()) do
    local user = by_handle[handle]
    local active = (user and user.active) or false
    local text = active and opts.active or opts.idle
    if opts.names then
      text = text .. " " .. ((user and user.display_name) or handle)
    end
    table.insert(cached_parts, { text = text, active = active })
  end

  local plain, native = {}, {}
  for _, part in ipairs(cached_parts) do
    table.insert(plain, part.text)
    local hl = part.active and "FriendsActive" or "FriendsIdle"
    table.insert(native, "%#" .. hl .. "#" .. part.text .. "%*")
  end
  cached_plain = table.concat(plain, opts.separator)
  cached_native = table.concat(native, opts.separator)
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
      last_data = vim.uv.now()
    end
    rebuild()
    if cb then
      cb()
    end
  end)
end

M.push = function(users)
  cached_users = users
  last_data = vim.uv.now()
  rebuild()
end

M.users = function()
  return cached_users
end

-- Highlighted by default (use inside '%{%...%}' in 'statusline').
-- Pass { hl = false } for the plain text.
M.statusline = function(opts)
  if opts and opts.hl == false then
    return cached_plain
  end
  return cached_native
end

-- One entry per friend: { text = "● name", active = bool }. For statusline
-- integrations that do their own highlighting (the lualine component).
M.parts = function()
  return cached_parts
end

local tick = function()
  local interval = config.options.status_interval * 1000
  if last_data and (vim.uv.now() - last_data) < interval then
    return
  end
  M.refresh()
end

M.start = function()
  if timer or config.options.status_interval <= 0 then
    return
  end
  M.refresh()
  timer = vim.uv.new_timer()
  local interval = config.options.status_interval * 1000
  timer:start(interval, interval, vim.schedule_wrap(tick))
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
