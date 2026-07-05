local M = {}

local HEARTBEAT_INTERVAL = tonumber(vim.env.FRIENDS_HEARTBEAT_INTERVAL) or 120
local IDLE_TIMEOUT = 300

local ns = vim.api.nvim_create_namespace("friends_tracker")
local timer = nil
local last_input = nil
local last_flush = nil

local warned_taken = false

local flush = function()
  local now = vim.uv.now()
  local elapsed = math.floor((now - (last_flush or now)) / 1000)
  last_flush = now
  if not last_input or (now - last_input) > IDLE_TIMEOUT * 1000 or elapsed < 1 then
    return
  end
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
  local mark = function()
    last_input = vim.uv.now()
  end
  vim.on_key(mark, ns)
  last_flush = vim.uv.now()
  timer = vim.uv.new_timer()
  local interval = HEARTBEAT_INTERVAL * 1000
  timer:start(interval, interval, vim.schedule_wrap(flush))

  local group = vim.api.nvim_create_augroup("FriendsTracker", {})
  vim.api.nvim_create_autocmd({ "CursorMoved", "FocusGained" }, {
    group = group,
    callback = mark,
  })
  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = group,
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
  last_input = nil
  vim.api.nvim_clear_autocmds({ group = "FriendsTracker" })
end

return M
