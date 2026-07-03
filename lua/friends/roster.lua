local config = require("friends.config")
local util = require("friends.util")

local M = {}

local roster_path = function()
  return config.data_dir() .. "/friends.json"
end

local saved = function()
  local list = util.read_json(roster_path())
  return (list and list.friends) or {}
end

M.all = function()
  local seen, out = {}, {}
  for _, source in ipairs({ config.options.friends, saved() }) do
    for _, handle in ipairs(source) do
      if not seen[handle] then
        seen[handle] = true
        table.insert(out, handle)
      end
    end
  end
  return out
end

M.add = function(handle)
  if vim.tbl_contains(M.all(), handle) then
    util.notify(handle .. " is already a friend")
    return
  end
  require("friends.api").status({ handle }, function(data)
    local user = data and data.users and data.users[1]
    if not data then
      util.notify(
        "could not verify " .. handle .. ": " .. (require("friends.api").last_error or "?"),
        vim.log.levels.ERROR
      )
      return
    end
    if not user then
      util.notify(handle .. " is not registered — no friend added", vim.log.levels.ERROR)
      return
    end
    local list = saved()
    table.insert(list, handle)
    util.write_json(roster_path(), { friends = list })
    local name = user.display_name and (" (" .. user.display_name .. ")") or ""
    util.notify(("added %s%s — %s total"):format(handle, name, util.duration(user.total_seconds)))
    require("friends.status").refresh()
  end)
end

M.remove = function(handle)
  local list = saved()
  local kept = vim.tbl_filter(function(h)
    return h ~= handle
  end, list)
  if #kept == #list and not vim.tbl_contains(config.options.friends, handle) then
    util.notify(handle .. " is not a friend", vim.log.levels.WARN)
    return
  end
  util.write_json(roster_path(), { friends = kept })
  if vim.tbl_contains(config.options.friends, handle) then
    util.notify(handle .. " also comes from setup(); remove it there too", vim.log.levels.WARN)
  else
    util.notify("removed " .. handle)
  end
  require("friends.status").refresh()
end

return M
