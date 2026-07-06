local config = require("friends.config")
local util = require("friends.util")

local M = {}

local ns = vim.api.nvim_create_namespace("friends_ui")

local highlight_icons = function(buf, lines, start_lnum)
  start_lnum = start_lnum or 0
  local icons = {
    { config.options.statusline.active, "FriendsActive" },
    { config.options.statusline.idle, "FriendsIdle" },
  }
  for lnum, line in ipairs(lines) do
    for _, spec in ipairs(icons) do
      local from = 1
      while true do
        local s, e = line:find(spec[1], from, true)
        if not s then
          break
        end
        vim.api.nvim_buf_set_extmark(buf, ns, start_lnum + lnum - 1, s - 1, { end_col = e, hl_group = spec[2] })
        from = e + 1
      end
    end
  end
end

local open_float = function(title, lines, float_opts)
  float_opts = float_opts or {}
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  highlight_icons(buf, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].filetype = "friends"

  local width = 0
  for _, line in ipairs(lines) do
    width = math.max(width, vim.fn.strdisplaywidth(line))
  end
  width = math.min(math.max(width + 2, 40), vim.o.columns - 4)
  local height = math.min(#lines, vim.o.lines - 6)

  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    row = math.floor((vim.o.lines - height) / 2) - 1,
    col = math.floor((vim.o.columns - width) / 2),
    width = width,
    height = height,
    style = "minimal",
    border = "rounded",
    title = " " .. title .. " ",
    title_pos = "center",
    footer = float_opts.footer and (" " .. float_opts.footer .. " ") or nil,
    footer_pos = float_opts.footer and "center" or nil,
  })
  vim.wo[win].cursorline = true

  for _, key in ipairs({ "q", "<Esc>" }) do
    vim.keymap.set("n", key, "<cmd>close<cr>", { buffer = buf, nowait = true })
  end
  for key, fn in pairs(float_opts.keys or {}) do
    vim.keymap.set("n", key, fn, { buffer = buf, nowait = true })
  end

  return buf, win
end

M.leaderboard = function()
  local opts = config.options.leaderboard
  local me = require("friends.identity").get().handle
  local request = { period = opts.period, limit = opts.limit }
  if opts.friends_only then
    local handles = require("friends.roster").all()
    table.insert(handles, me)
    request.handles = handles
  end

  require("friends.api").leaderboard(request, function(data)
    if not data then
      util.notify("leaderboard failed: " .. (require("friends.api").last_error or "?"), vim.log.levels.ERROR)
      return
    end
    local lines = {}
    for _, entry in ipairs(data.entries) do
      local name = entry.display_name or entry.handle
      local you = entry.handle == me and "  (you)" or ""
      table.insert(
        lines,
        string.format(
          " %2d. %s %-24s %10s%s",
          entry.rank,
          entry.active and config.options.statusline.active or " ",
          name,
          util.duration(entry.seconds),
          you
        )
      )
    end
    if #lines == 0 then
      lines = { " nobody here yet — get typing" }
    end
    open_float("friends.nvim — " .. data.period, lines, {
      footer = "a: follow · q: close",
      keys = {
        a = function()
          local entry = data.entries[vim.api.nvim_win_get_cursor(0)[1]]
          if not entry then
            return
          end
          if entry.handle == me then
            util.notify("that's you")
            return
          end
          require("friends.roster").add(entry.handle)
        end,
      },
    })
  end)
end

local DETAIL_ROWS = 1

local detail_fields = function(entry)
  if not entry.user then
    return { { "status", "unregistered" } }
  end
  return {
    { "last active", util.time_ago(entry.user.last_seen_at) },
  }
end

local render_detail = function(buf, win, entries, index)
  local lines = { string.rep("─", vim.api.nvim_win_get_width(win)) }
  for _, field in ipairs(detail_fields(entries[index])) do
    table.insert(lines, string.format(" %s: %s", field[1], field[2]))
  end
  while #lines < 1 + DETAIL_ROWS do
    table.insert(lines, "")
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, #entries, -1, false, lines)
  vim.bo[buf].modifiable = false
  highlight_icons(buf, lines, #entries)
end

M.list = function()
  require("friends.status").refresh(function()
    local roster = require("friends.roster").all()
    if #roster == 0 then
      util.notify("no friends yet — :Friends add {handle}")
      return
    end
    local by_handle = {}
    for _, user in ipairs(require("friends.status").users()) do
      by_handle[user.handle] = user
    end
    local lines = {}
    local entries = {}
    for _, handle in ipairs(roster) do
      local user = by_handle[handle]
      local icon = (user and user.active) and config.options.statusline.active or config.options.statusline.idle
      local name = (user and user.display_name) and (user.display_name .. " · " .. handle) or handle
      local total = user and util.duration(user.total_seconds) or "unregistered"
      table.insert(lines, string.format(" %s %-40s %10s", icon, name, total))
      table.insert(entries, { handle = handle, user = user })
    end
    for _ = 1, 1 + DETAIL_ROWS do
      table.insert(lines, "")
    end
    local buf, win = open_float("friends.nvim — friends", lines)
    render_detail(buf, win, entries, 1)

    local last_index = 1
    vim.api.nvim_create_autocmd("CursorMoved", {
      buffer = buf,
      callback = function()
        local cur = vim.api.nvim_win_get_cursor(win)
        local index = math.min(cur[1], #entries)
        if index ~= cur[1] then
          vim.api.nvim_win_set_cursor(win, { index, cur[2] })
        end
        if index ~= last_index then
          last_index = index
          render_detail(buf, win, entries, index)
        end
      end,
    })
  end)
end

return M
