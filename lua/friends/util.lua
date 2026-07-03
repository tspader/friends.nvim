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

return M
