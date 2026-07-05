local config = require("friends.config")

local M = {}

local ns = vim.api.nvim_create_namespace("friends_tracker")
local timer = nil
local active = false
local last_flush = nil

local warned_taken = false

local flush = function()
  local now = vim.uv.now()
  local elapsed = math.floor((now - (last_flush or now)) / 1000)
  last_flush = now
  if not active or elapsed < 1 then
    return
  end
  active = false
  local identity = require("friends.identity").get()
  local handles = require("friends.roster").all()
  require("friends.api").heartbeat(
    identity.handle,
    identity.token,
    math.min(300, elapsed),
    handles,
    function(data, status)
      if data and data.users then
        require("friends.status").push(data.users)
      end
      if status == 404 then
        require("friends.identity").register()
      elseif status == 403 and not warned_taken then
        warned_taken = true
        require("friends.util").notify(
          identity.handle .. " is owned by another machine's key — fix with :Friends claim",
          vim.log.levels.WARN
        )
      end
    end
  )
end

M.running = function()
  return timer ~= nil
end

M.start = function()
  if timer then
    return
  end
  vim.on_key(function()
    active = true
  end, ns)
  last_flush = vim.uv.now()
  timer = vim.uv.new_timer()
  local interval = config.options.heartbeat_interval * 1000
  timer:start(interval, interval, vim.schedule_wrap(flush))

  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = vim.api.nvim_create_augroup("FriendsTracker", {}),
    callback = function()
      pcall(flush)
      -- Give the curl job a beat to get the request out the door.
      vim.wait(200)
    end,
  })
end

M.stop = function()
  if not timer then
    return
  end
  vim.on_key(nil, ns)
  timer:stop()
  timer:close()
  timer = nil
  active = false
end

return M
