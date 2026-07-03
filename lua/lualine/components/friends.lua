local function friends()
  local ok, plugin = pcall(require, "friends")
  if not ok then
    return ""
  end
  return plugin.statusline()
end

return friends
