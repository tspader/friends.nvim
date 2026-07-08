local config = require("friends.config")
local util = require("friends.util")

local M = {}

local ns = vim.api.nvim_create_namespace("friends_ui")

local highlight_icons = function(buf, lines)
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
        vim.api.nvim_buf_set_extmark(buf, ns, lnum - 1, s - 1, { end_col = e, hl_group = spec[2] })
        from = e + 1
      end
    end
  end
end

-- reserve: screen rows kept free below the float for a companion window.
local float_geometry = function(lines, reserve)
  local width = 0
  for _, line in ipairs(lines) do
    width = math.max(width, vim.fn.strdisplaywidth(line))
  end
  width = math.min(math.max(width + 2, 40), vim.o.columns - 4)
  local height = math.min(#lines, math.max(1, vim.o.lines - 6 - reserve))
  return {
    row = math.floor((vim.o.lines - height - reserve) / 2) - 1,
    col = math.floor((vim.o.columns - width) / 2),
    width = width,
    height = height,
  }
end

local open_float = function(title, lines, float_opts)
  float_opts = float_opts or {}
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  highlight_icons(buf, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].filetype = "friends"

  local geo = float_geometry(lines, float_opts.reserve or 0)
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    row = geo.row,
    col = geo.col,
    width = geo.width,
    height = geo.height,
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
  for key, spec in pairs(float_opts.keys or {}) do
    local fn = type(spec) == "function" and spec or spec[1]
    local desc = type(spec) == "table" and spec.desc or nil
    vim.keymap.set("n", key, fn, { buffer = buf, nowait = true, desc = desc })
  end

  return buf, win
end

local update_float = function(buf, win, lines, reserve)
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  highlight_icons(buf, lines)
  if vim.api.nvim_win_is_valid(win) then
    local geo = float_geometry(lines, reserve or 0)
    vim.api.nvim_win_set_config(win, {
      relative = "editor",
      row = geo.row,
      col = geo.col,
      width = geo.width,
      height = geo.height,
    })
  end
end

M.leaderboard = function(opts)
  local board = require("friends.board")
  for axis in pairs(board.axes) do
    local value = opts and opts[axis]
    if value and not board.set(axis, value) then
      util.notify(
        ("invalid %s '%s' (valid: %s)"):format(axis, value, table.concat(board.axes[axis], ", ")),
        vim.log.levels.ERROR
      )
      return
    end
  end

  local cfg = config.options.leaderboard
  local me = require("friends.identity").get().handle
  local entries = {}
  local generation = 0
  local buf, win

  local fetch = function()
    generation = generation + 1
    local gen = generation
    local request = { period = board.get("period"), metric = board.get("metric"), limit = cfg.limit }
    if cfg.friends_only then
      local handles = require("friends.roster").all()
      table.insert(handles, me)
      request.handles = handles
    end
    require("friends.api").leaderboard(request, function(data)
      -- Drop responses from superseded fetches so rapid period switches
      -- never render a stale period, and bail if the float was closed.
      if gen ~= generation or not vim.api.nvim_buf_is_valid(buf) then
        return
      end
      if not data then
        util.notify("leaderboard failed: " .. (require("friends.api").last_error or "?"), vim.log.levels.ERROR)
        update_float(buf, win, { " leaderboard failed" })
        return
      end
      local formatter = util.formatters[board.get("metric")] or util.count
      local lines = {}
      for i, entry in ipairs(data.entries) do
        entries[i] = entry
        local name = entry.display_name or entry.handle
        local you = entry.handle == me and "  (you)" or ""
        table.insert(
          lines,
          string.format(
            " %2d. %s %-24s %10s%s",
            entry.rank,
            entry.active and config.options.statusline.active or " ",
            name,
            formatter(entry.value),
            you
          )
        )
      end
      if #lines == 0 then
        lines = { " nobody here yet — get typing" }
      end
      update_float(buf, win, lines)
    end)
  end

  local switch = function(change)
    change()
    -- Clear in place: `entries` is the follow keymap's upvalue, and stale
    -- rows must not be followable while the placeholder is shown.
    for i = #entries, 1, -1 do
      entries[i] = nil
    end
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_set_config(win, {
        title = " friends.nvim — " .. board.get("metric") .. " — " .. board.get("period") .. " ",
        title_pos = "center",
      })
    end
    update_float(buf, win, { " fetching leaderboard…" })
    fetch()
  end

  buf, win = open_float(
    "friends.nvim — " .. board.get("metric") .. " — " .. board.get("period"),
    { " fetching leaderboard…" },
    {
      footer = "a follow · <Tab> period · m metric · q close",
      keys = {
        a = {
          function()
            local entry = entries[vim.api.nvim_win_get_cursor(0)[1]]
            if not entry then
              return
            end
            if entry.handle == me then
              util.notify("that's you")
              return
            end
            require("friends.roster").add(entry.handle)
          end,
          desc = "follow user",
        },
        ["<Tab>"] = {
          function()
            switch(function()
              board.cycle("period", 1)
            end)
          end,
          desc = "next period",
        },
        ["<S-Tab>"] = {
          function()
            switch(function()
              board.cycle("period", -1)
            end)
          end,
          desc = "previous period",
        },
        p = {
          function()
            vim.ui.select(board.axes.period, { prompt = "leaderboard period" }, function(choice)
              if choice then
                switch(function()
                  board.set("period", choice)
                end)
              end
            end)
          end,
          desc = "pick period",
        },
        m = {
          function()
            switch(function()
              board.cycle("metric", 1)
            end)
          end,
          desc = "toggle metric",
        },
      },
    }
  )

  fetch()
end

local detail_fields = function(entry)
  if entry.pending then
    return { { "status", "fetching…" } }
  end
  if not entry.user then
    return { { "status", "unregistered" } }
  end
  return {
    { "last active", util.time_ago(entry.user.last_seen_at) },
  }
end

local list_lines = function(roster)
  local status = require("friends.status")
  local by_handle = {}
  for _, user in ipairs(status.users()) do
    by_handle[user.handle] = user
  end
  local fetched = status.fetched()
  local lines, entries = {}, {}
  for _, handle in ipairs(roster) do
    local user = by_handle[handle]
    local icon = (user and user.active) and config.options.statusline.active or config.options.statusline.idle
    local name = (user and user.display_name) and (user.display_name .. " · " .. handle) or handle
    local total = user and util.duration(user.total_seconds) or (fetched and "unregistered" or "…")
    table.insert(lines, string.format(" %s %-40s %10s", icon, name, total))
    table.insert(entries, { handle = handle, user = user, pending = (not user and not fetched) or nil })
  end
  return lines, entries
end

local render_detail = function(buf, entries, index)
  local lines = {}
  for _, field in ipairs(detail_fields(entries[index])) do
    table.insert(lines, string.format(" %s: %s", field[1], field[2]))
  end
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
end

M.list = function()
  local roster = require("friends.roster").all()
  if #roster == 0 then
    util.notify("no friends yet — :Friends add {handle}")
    return
  end
  local lines, entries = list_lines(roster)

  local detail_rows = 1
  for _, entry in ipairs(entries) do
    detail_rows = math.max(detail_rows, #detail_fields(entry))
  end
  local reserve = detail_rows + 2

  local buf, win = open_float("friends.nvim — friends", lines, { reserve = reserve })
  local cfg = vim.api.nvim_win_get_config(win)

  local detail_buf = vim.api.nvim_create_buf(false, true)
  vim.bo[detail_buf].bufhidden = "wipe"
  local detail_win = vim.api.nvim_open_win(detail_buf, false, {
    relative = "editor",
    row = cfg.row + cfg.height + 2,
    col = cfg.col,
    width = cfg.width,
    height = detail_rows,
    style = "minimal",
    border = "rounded",
    focusable = false,
  })
  render_detail(detail_buf, entries, 1)

  local last_index = 1
  vim.api.nvim_create_autocmd("CursorMoved", {
    buffer = buf,
    callback = function()
      local index = vim.api.nvim_win_get_cursor(0)[1]
      if index ~= last_index and vim.api.nvim_win_is_valid(detail_win) then
        last_index = index
        render_detail(detail_buf, entries, index)
      end
    end,
  })
  vim.api.nvim_create_autocmd("WinClosed", {
    pattern = tostring(win),
    once = true,
    callback = function()
      if vim.api.nvim_win_is_valid(detail_win) then
        vim.api.nvim_win_close(detail_win, true)
      end
    end,
  })

  require("friends.status").refresh(function()
    if not vim.api.nvim_buf_is_valid(buf) then
      return
    end
    local new_lines, new_entries = list_lines(roster)
    for i, entry in ipairs(new_entries) do
      entries[i] = entry
    end
    update_float(buf, win, new_lines, reserve)
    if vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_is_valid(detail_win) then
      local moved = vim.api.nvim_win_get_config(win)
      vim.api.nvim_win_set_config(detail_win, {
        relative = "editor",
        row = moved.row + moved.height + 2,
        col = moved.col,
        width = moved.width,
        height = detail_rows,
      })
      render_detail(detail_buf, entries, vim.api.nvim_win_get_cursor(win)[1])
    end
  end)
end

return M
