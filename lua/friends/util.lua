local M = {}

M.read_json = function(path)
  local fd = io.open(path, "r")
  if not fd then
    return nil
  end
  local content = fd:read("*a")
  fd:close()
  local ok, decoded = pcall(vim.json.decode, content)
  if not ok or type(decoded) ~= "table" then
    return nil
  end
  return decoded
end

M.write_json = function(path, tbl)
  vim.fn.mkdir(vim.fs.dirname(path), "p")
  local fd = io.open(path, "w")
  if not fd then
    return false
  end
  fd:write(vim.json.encode(tbl))
  fd:close()
  return true
end

M.notify = function(msg, level)
  vim.notify("friends.nvim: " .. msg, level or vim.log.levels.INFO)
end

M.duration = function(seconds)
  seconds = math.max(0, math.floor(seconds or 0))
  local hours = math.floor(seconds / 3600)
  local minutes = math.floor((seconds % 3600) / 60)
  if hours > 0 then
    return string.format("%dh %02dm", hours, minutes)
  end
  return string.format("%dm", minutes)
end

M.time_ago = function(unix_seconds)
  if not unix_seconds then
    return "never"
  end
  local ago = math.max(0, os.time() - math.floor(unix_seconds))
  if ago < 60 then
    return "just now"
  end
  if ago < 3600 then
    return string.format("%dm ago", math.floor(ago / 60))
  end
  if ago < 86400 then
    local hours = math.floor(ago / 3600)
    local minutes = math.floor((ago % 3600) / 60)
    if minutes == 0 then
      return string.format("%dh ago", hours)
    end
    return string.format("%dh %dm ago", hours, minutes)
  end
  local days = math.floor(ago / 86400)
  local hours = math.floor((ago % 86400) / 3600)
  if hours == 0 then
    return string.format("%dd ago", days)
  end
  return string.format("%dd %dh ago", days, hours)
end

return M
