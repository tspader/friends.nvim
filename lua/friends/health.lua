local M = {}

M.check = function()
  local health = vim.health
  local config = require("friends.config")

  health.start("friends.nvim")

  if vim.fn.executable("curl") == 1 then
    health.ok("curl executable found")
  else
    health.error("curl not found in PATH")
  end

  local identity = require("friends.identity").get()
  health.ok("handle: " .. identity.handle)
  local display_name = require("friends.identity").display_name()
  if display_name then
    health.ok("display name: " .. display_name)
  else
    health.info("no display name set (:Friends name {name})")
  end

  local friends = require("friends.roster").all()
  health.info(("following %d friend(s)"):format(#friends))

  if require("friends.tracker").running() then
    health.ok("activity tracking running")
  else
    health.warn("activity tracking not running")
  end

  if require("friends.api").ping() then
    health.ok("backend reachable: " .. config.options.url)
  else
    health.error("backend unreachable: " .. config.options.url)
  end
end

return M
