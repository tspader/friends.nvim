local util = require("friends.util")

local M = {}

local subcommands = {
  add = {
    args = true,
    impl = function(args)
      if not args[1] then
        util.notify("usage: :Friends add {handle}", vim.log.levels.ERROR)
        return
      end
      require("friends.roster").add(args[1])
    end,
  },
  remove = {
    args = true,
    impl = function(args)
      if not args[1] then
        util.notify("usage: :Friends remove {handle}", vim.log.levels.ERROR)
        return
      end
      require("friends.roster").remove(args[1])
    end,
  },
  ping = {
    args = true,
    impl = function(args)
      if not args[1] then
        util.notify("usage: :Friends ping {handle} [message]", vim.log.levels.ERROR)
        return
      end
      local matches = require("friends.roster").resolve(args[1])
      if #matches == 0 then
        util.notify(args[1] .. " isn't a friend — add them first with :Friends add", vim.log.levels.ERROR)
        return
      elseif #matches > 1 then
        util.notify(
          args[1] .. " matches multiple friends (" .. table.concat(matches, ", ") .. ") — use a handle instead",
          vim.log.levels.ERROR
        )
        return
      end
      local handle = matches[1]
      local identity = require("friends.identity").get()
      local message = #args > 1 and table.concat(vim.list_slice(args, 2), " ") or nil
      require("friends.api").send_ping(identity.handle, identity.token, handle, message, function(_, status, code)
        if code == "unknown_handle" then
          util.notify("you gotta register before you can ping", vim.log.levels.ERROR)
        elseif status == 404 then
          util.notify(handle .. " isn't registered", vim.log.levels.ERROR)
        elseif status == 429 then
          util.notify("the refractory period is not a joke", vim.log.levels.WARN)
        elseif not status or status < 200 or status >= 300 then
          util.notify("ping failed: " .. (require("friends.api").last_error or "?"), vim.log.levels.ERROR)
        else
          util.notify("pinged " .. handle)
        end
      end)
    end,
  },
  list = {
    impl = function()
      require("friends.ui").list()
    end,
  },
  board = {
    args = true,
    impl = function(args)
      local opts = {}
      for _, value in ipairs(args) do
        local axis = require("friends.board").axis_of(value)
        if not axis then
          util.notify("invalid leaderboard option: " .. value, vim.log.levels.ERROR)
          return
        end
        opts[axis] = value
      end
      require("friends.ui").leaderboard(opts)
    end,
  },
  name = {
    args = true,
    impl = function(args)
      if not args[1] then
        util.notify("usage: :Friends name {display name}", vim.log.levels.ERROR)
        return
      end
      if args[2] then
        util.notify("display names can't contain spaces", vim.log.levels.ERROR)
        return
      end
      require("friends.identity").set_display_name(args[1])
    end,
  },
  handle = {
    impl = function()
      util.notify("your handle is " .. require("friends.identity").get().handle)
    end,
  },
  key = {
    impl = function()
      util.notify("your key (handle + secret, for :Friends claim on another machine):\n"
        .. require("friends.identity").key())
    end,
  },
  claim = {
    args = true,
    impl = function(args)
      if not args[1] or not args[2] then
        util.notify("usage: :Friends claim {handle} {token}  (see :Friends key)", vim.log.levels.ERROR)
        return
      end
      require("friends.identity").claim(args[1], args[2])
    end,
  },
  toggle = {
    impl = function()
      require("friends").toggle()
    end,
  },
  delete = {
    impl = function()
      local identity = require("friends.identity")
      local handle = identity.get().handle
      local choice = vim.fn.confirm(
        "Delete " .. handle .. " and all its data from the server? This cannot be undone.",
        "&Yes\n&No",
        2
      )
      if choice == 1 then
        identity.delete()
      end
    end,
  },
}

M.run = function(fargs)
  if #fargs == 0 then
    require("friends.ui").leaderboard()
    return
  end
  local sub = subcommands[fargs[1]]
  if not sub then
    util.notify("unknown subcommand: " .. fargs[1], vim.log.levels.ERROR)
    return
  end
  sub.impl(vim.list_slice(fargs, 2))
end

M.complete = function(arglead, line)
  local words = vim.split(line, "%s+", { trimempty = true })
  if #words > 2 or (#words == 2 and arglead == "") then
    if words[2] == "remove" then
      return vim.tbl_filter(function(h)
        return vim.startswith(h, arglead)
      end, require("friends.roster").all())
    end
    if words[2] == "ping" then
      local roster = require("friends.roster").all()
      local candidates = vim.list_extend({}, roster)
      for _, user in ipairs(require("friends.status").users()) do
        if user.display_name and vim.tbl_contains(roster, user.handle) and not vim.tbl_contains(candidates, user.display_name) then
          table.insert(candidates, user.display_name)
        end
      end
      return vim.tbl_filter(function(c)
        return vim.startswith(c, arglead)
      end, candidates)
    end
    if words[2] == "board" then
      local values = {}
      for _, axis_values in pairs(require("friends.board").axes) do
        vim.list_extend(values, axis_values)
      end
      return vim.tbl_filter(function(v)
        return vim.startswith(v, arglead)
      end, values)
    end
    return {}
  end
  return vim.tbl_filter(function(name)
    return vim.startswith(name, arglead)
  end, vim.tbl_keys(subcommands))
end

return M
