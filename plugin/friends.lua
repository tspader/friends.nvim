if 1 ~= vim.fn.has("nvim-0.10") then
  vim.notify("friends.nvim requires at least nvim-0.10", vim.log.levels.ERROR)
  return
end

if vim.g.loaded_friends == 1 then
  return
end
vim.g.loaded_friends = 1

local set_highlights = function()
  vim.api.nvim_set_hl(0, "FriendsActive", { link = "DiagnosticOk", default = true })
  vim.api.nvim_set_hl(0, "FriendsIdle", { link = "Comment", default = true })
end
set_highlights()
vim.api.nvim_create_autocmd("ColorScheme", {
  group = vim.api.nvim_create_augroup("FriendsHighlights", {}),
  callback = set_highlights,
})

vim.api.nvim_create_user_command("Friends", function(opts)
  require("friends.command").run(opts.fargs)
end, {
  nargs = "*",
  desc = "friends.nvim: leaderboard | add/remove {handle} | list | name {name} | handle | key | claim | toggle",
  complete = function(arglead, line)
    return require("friends.command").complete(arglead, line)
  end,
})

if vim.g.friends_autostart == false then
  return
end

if vim.v.vim_did_enter == 1 then
  vim.schedule(function()
    require("friends").start()
  end)
else
  vim.api.nvim_create_autocmd("VimEnter", {
    group = vim.api.nvim_create_augroup("FriendsStart", {}),
    once = true,
    callback = function()
      require("friends").start()
    end,
  })
end
