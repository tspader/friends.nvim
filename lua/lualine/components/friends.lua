local ok, lualine_component = pcall(require, "lualine.component")
if not ok then
  return function()
    local ok_friends, friends = pcall(require, "friends")
    return ok_friends and friends.statusline({ hl = false }) or ""
  end
end

local M = lualine_component:extend()

function M:init(options)
  M.super.init(self, options)
  self.hl_active = self:create_hl("FriendsActive", "active")
  self.hl_idle = self:create_hl("FriendsIdle", "idle")
end

function M:update_status()
  local ok_status, status = pcall(require, "friends.status")
  if not ok_status then
    return ""
  end
  local parts = status.parts()
  if #parts == 0 then
    return ""
  end
  local separator = require("friends.config").options.statusline.separator
  local out = {}
  for _, part in ipairs(parts) do
    local hl = self:format_hl(part.active and self.hl_active or self.hl_idle)
    table.insert(out, hl .. part.text)
  end
  return table.concat(out, separator)
end

return M
