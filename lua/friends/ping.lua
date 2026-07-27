local config = require("friends.config")

local M = {}

local timer = nil
local active = {}

local geometry = function(lines, stack_index)
  local width = 0
  for _, line in ipairs(lines) do
    width = math.max(width, vim.fn.strdisplaywidth(line))
  end
  width = math.min(math.max(width + 2, 24), vim.o.columns - 4)
  local height = #lines
  local row = vim.o.lines - height - 3 - stack_index * (height + 1)
  local col = vim.o.columns - width - 2
  return { row = math.max(0, row), col = math.max(0, col), width = width, height = height }
end

local reflow = function()
  for i, entry in ipairs(active) do
    if vim.api.nvim_win_is_valid(entry.win) then
      local geo = geometry(entry.lines, i - 1)
      vim.api.nvim_win_set_config(entry.win, { relative = "editor", row = geo.row, col = geo.col })
    end
  end
end

local close = function(entry)
  for i, e in ipairs(active) do
    if e == entry then
      table.remove(active, i)
      break
    end
  end
  if vim.api.nvim_win_is_valid(entry.win) then
    vim.api.nvim_win_close(entry.win, true)
  end
  reflow()
end

M.show = function(from, message)
  local by_handle = {}
  for _, user in ipairs(require("friends.status").users()) do
    by_handle[user.handle] = user
  end
  local name = (by_handle[from] and by_handle[from].display_name) or from
  local lines = { " " .. name .. " pinged you" }
  if message and message ~= "" then
    table.insert(lines, " " .. message)
  end

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].bufhidden = "wipe"

  local geo = geometry(lines, #active)
  local win = vim.api.nvim_open_win(buf, false, {
    relative = "editor",
    row = geo.row,
    col = geo.col,
    width = geo.width,
    height = geo.height,
    style = "minimal",
    border = "rounded",
    focusable = false,
    noautocmd = true,
    zindex = 300,
  })

  local entry = { win = win, lines = lines }
  table.insert(active, entry)
  vim.defer_fn(function()
    close(entry)
  end, config.options.ping.duration_ms)
end

local poll = function()
  local identity = require("friends.identity").get()
  require("friends.api").poll_pings(identity.handle, identity.token, function(data, status)
    if data and data.pings then
      for _, entry in ipairs(data.pings) do
        M.show(entry.from, entry.message)
      end
    end
    if status == 404 then
      require("friends.identity").register()
    end
  end)
end

M.start = function()
  if timer or not config.options.ping.enabled or config.options.ping.poll_interval <= 0 then
    return
  end
  timer = vim.uv.new_timer()
  local interval = config.options.ping.poll_interval * 1000
  timer:start(interval, interval, vim.schedule_wrap(poll))
end

M.stop = function()
  if not timer then
    return
  end
  timer:stop()
  timer:close()
  timer = nil
  local snapshot = {}
  for i, entry in ipairs(active) do
    snapshot[i] = entry
  end
  for _, entry in ipairs(snapshot) do
    close(entry)
  end
end

return M
