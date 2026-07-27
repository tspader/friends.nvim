local config = require("friends.config")

local M = {}

local MAX_VISIBLE = 3
local BORDER_ROWS = 2

local active = {}

local truncate = function(line, width)
  if vim.fn.strdisplaywidth(line) <= width then
    return line
  end
  local chars = vim.fn.strchars(line)
  while chars > 0 and vim.fn.strdisplaywidth(vim.fn.strcharpart(line, 0, chars) .. "…") > width do
    chars = chars - 1
  end
  return vim.fn.strcharpart(line, 0, chars) .. "…"
end

local geometry = function(lines, rows_below)
  local width = 0
  for _, line in ipairs(lines) do
    width = math.max(width, vim.fn.strdisplaywidth(line))
  end
  width = math.min(math.max(width + 2, 24), vim.o.columns - 4)
  local height = math.min(#lines, math.max(1, vim.o.lines - 3 - BORDER_ROWS - rows_below))
  local row = vim.o.lines - 3 - height - rows_below
  local col = vim.o.columns - width - 2
  return { row = math.max(0, row), col = math.max(0, col), width = width, height = height }
end

local stack_offset = function()
  local rows_below = 0
  for _, entry in ipairs(active) do
    rows_below = rows_below + geometry(entry.lines, rows_below).height + BORDER_ROWS
  end
  return rows_below
end

local reflow = function()
  local rows_below = 0
  for _, entry in ipairs(active) do
    local geo = geometry(entry.lines, rows_below)
    if vim.api.nvim_win_is_valid(entry.win) then
      vim.api.nvim_win_set_config(entry.win, { relative = "editor", row = geo.row, col = geo.col })
    end
    rows_below = rows_below + geo.height + BORDER_ROWS
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
  local lines = { " " .. require("friends.status").display_name(from) .. " pinged you" }
  if message and message ~= "" then
    table.insert(lines, " " .. message)
  end

  local geo = geometry(lines, stack_offset())
  for i, line in ipairs(lines) do
    lines[i] = truncate(line, geo.width)
  end

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].modifiable = false

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
  vim.wo[win].wrap = false

  local entry = { win = win, lines = lines }
  table.insert(active, entry)
  vim.defer_fn(function()
    close(entry)
  end, config.options.ping.duration_ms)
end

M.deliver = function(pings)
  if not config.options.ping.enabled then
    return
  end
  local roster = require("friends.roster").all()
  for _, ping in ipairs(pings) do
    if vim.tbl_contains(roster, ping.from) then
      if #active < MAX_VISIBLE then
        M.show(ping.from, ping.message)
      else
        local name = require("friends.status").display_name(ping.from)
        require("friends.util").notify(
          name .. " pinged you" .. (ping.message and (": " .. ping.message) or "")
        )
      end
    end
  end
end

M.dismiss = function()
  while #active > 0 do
    close(active[1])
  end
end

return M
