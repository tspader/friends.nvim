local config = require("friends.config")

local M = {}

-- Ordered; values must be unique across axes (:Friends board infers the
-- axis from the value). Append "month"/"year" to period when the backend
-- supports them; new metrics get appended to metric the same way.
M.axes = {
  period = { "today", "week", "all" },
  metric = { "active_time", "keys_pressed" },
}

local current = {}

M.valid = function(axis, value)
  return vim.tbl_contains(M.axes[axis] or {}, value)
end

M.axis_of = function(value)
  for axis, values in pairs(M.axes) do
    if vim.tbl_contains(values, value) then
      return axis
    end
  end
end

M.get = function(axis)
  if not current[axis] then
    local configured = config.options.leaderboard[axis]
    current[axis] = M.valid(axis, configured) and configured or M.axes[axis][1]
  end
  return current[axis]
end

M.set = function(axis, value)
  if not M.valid(axis, value) then
    return false
  end
  current[axis] = value
  return true
end

M.cycle = function(axis, step)
  local values = M.axes[axis]
  local index = 1
  for i, value in ipairs(values) do
    if value == M.get(axis) then
      index = i
    end
  end
  current[axis] = values[(index - 1 + step) % #values + 1]
  return current[axis]
end

return M
