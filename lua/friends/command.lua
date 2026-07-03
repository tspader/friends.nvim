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
  list = {
    impl = function()
      require("friends.ui").list()
    end,
  },
  name = {
    args = true,
    impl = function(args)
      if not args[1] then
        util.notify("usage: :Friends name {display name}", vim.log.levels.ERROR)
        return
      end
      require("friends.identity").set_display_name(table.concat(args, " "))
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
    return {}
  end
  return vim.tbl_filter(function(name)
    return vim.startswith(name, arglead)
  end, vim.tbl_keys(subcommands))
end

return M
