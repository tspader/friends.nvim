local M = {}

M.defaults = function()
  return {
    -- Backend to talk to. Point this at your own worker to self host.
    url = "https://friends.spader.zone/api",
    -- Handles you follow. Merged with the ones added via :Friends add.
    friends = {},
    -- Display name pushed to the backend on startup. Overrides :Friends name.
    display_name = nil,
    -- Send activity heartbeats. Disable to lurk: leaderboard and friend
    -- status keep working but you never appear in them.
    track = true,
    -- Seconds between friend status refreshes for the statusline. 0 disables.
    status_interval = 120,
    -- Request timeout in milliseconds.
    request_timeout = 5000,
    statusline = {
      active = "●",
      idle = "○",
      separator = " ",
      -- Show each friend's name next to their dot.
      names = false,
    },
    leaderboard = {
      period = "week", -- all | week | today
      metric = "active_time", -- active_time | keys_pressed
      limit = 20,
      -- Only rank you and your friends instead of the whole world.
      friends_only = false,
    },
    ping = {
      -- Show pings from friends. Sending is unaffected by this option.
      -- Pings ride along with activity heartbeats, so they only arrive
      -- while you are tracking and editing. Pings from handles outside
      -- your roster are ignored.
      enabled = true,
      -- How long the ping popup stays on screen, in milliseconds.
      duration_ms = 4000,
    },
  }
end

M.options = M.defaults()

M.setup = function(opts)
  M.options = vim.tbl_deep_extend("force", M.defaults(), M.options, opts or {})
end

M.data_dir = function()
  return vim.fn.stdpath("data") .. "/friends.nvim"
end

return M
