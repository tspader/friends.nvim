local M = {}

local started = false

M.setup = function(opts)
  require("friends.config").setup(opts)
end

M.start = function()
  if started then
    return
  end
  started = true
  local config = require("friends.config")
  if config.options.track then
    require("friends.identity").register()
    require("friends.tracker").start()
  end
  require("friends.status").start()
end

M.stop = function()
  require("friends.tracker").stop()
  require("friends.status").stop()
  started = false
end

M.toggle = function()
  local tracker = require("friends.tracker")
  if tracker.running() then
    tracker.stop()
    require("friends.util").notify("tracking paused")
  else
    tracker.start()
    require("friends.util").notify("tracking resumed")
  end
end

M.statusline = function()
  return require("friends.status").statusline()
end

M.handle = function()
  return require("friends.identity").get().handle
end

return M
