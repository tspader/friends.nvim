local config = require("friends.config")
local util = require("friends.util")

local M = {}

local ADJECTIVES = {
  "cryptic", "dire", "mississippi", "truckin", "stella", "dark", "sugar", "lazy", "franklins", "estimated", "terrapin", "browneyed", "cryptical", "tennessee", "mexicali", "wharf",
}

local ANIMALS = {
  "halfstep", "star", "stephen", "magnolia", "lighting", "slipknot", "prophet", "station", "casey", "jones", "jerry", "phil", "bobby", "billy", "mickey", "keith", "garcia", "lesh", "weir", "kreutzmann", "hart", "godcheaux", "envelopment", "jed", "althea", "blues", "rat", "devil",
}

local identity_path = function()
  return config.data_dir() .. "/identity.json"
end

local cached = nil
local seeded = false

local seed = function()
  if not seeded then
    math.randomseed(vim.uv.hrtime() % 0x7fffffff)
    seeded = true
  end
end

M.generate = function()
  seed()
  return string.format(
    "%s-%s-%02d",
    ADJECTIVES[math.random(#ADJECTIVES)],
    ANIMALS[math.random(#ANIMALS)],
    math.random(0, 99)
  )
end

local generate_token = function()
  seed()
  local parts = {}
  for _ = 1, 4 do
    table.insert(parts, string.format("%04x", math.random(0, 0xffff)))
  end
  return table.concat(parts)
end

M.get = function()
  if cached then
    return cached
  end
  cached = util.read_json(identity_path())
  if not cached or type(cached.handle) ~= "string" then
    cached = { handle = M.generate(), token = generate_token() }
    util.write_json(identity_path(), cached)
    util.notify("you are " .. cached.handle .. " — share it with :Friends handle")
  elseif type(cached.token) ~= "string" then
    cached.token = generate_token()
    util.write_json(identity_path(), cached)
  end
  return cached
end

-- Registers the current identity, regenerating the handle on collision.
M.register = function(attempt)
  attempt = attempt or 1
  local identity = M.get()
  require("friends.api").register(identity.handle, identity.token, M.display_name(), function(_, status)
    if status ~= 409 then
      return
    end
    if attempt >= 5 then
      util.notify("could not claim a handle after 5 tries", vim.log.levels.ERROR)
      return
    end
    identity.handle = M.generate()
    util.write_json(identity_path(), identity)
    util.notify("handle taken, you are now " .. identity.handle)
    require("friends.socket").restart()
    M.register(attempt + 1)
  end)
end

M.claim = function(handle, token, cb)
  cb = cb or function() end
  require("friends.api").register(handle, token, nil, function(data, status)
    if data then
      cached = { handle = handle, token = token, display_name = data.display_name }
      util.write_json(identity_path(), cached)
      require("friends.socket").restart()
      util.notify("claimed " .. handle)
      cb(true)
    elseif status == 409 then
      util.notify("wrong token for " .. handle, vim.log.levels.ERROR)
      cb(false)
    else
      util.notify(
        "claim failed: " .. (require("friends.api").last_error or "?"),
        vim.log.levels.ERROR
      )
      cb(false)
    end
  end)
end

M.delete = function(cb)
  cb = cb or function() end
  local identity = M.get()
  local handle = identity.handle
  require("friends.api").delete(handle, identity.token, function(data, status)
    if data or status == 404 then
      os.remove(identity_path())
      cached = nil
      require("friends.socket").restart()
      util.notify("deleted " .. handle .. " — a new identity will be created")
      cb(true)
    else
      util.notify(
        "delete failed: " .. (require("friends.api").last_error or "?"),
        vim.log.levels.ERROR
      )
      cb(false)
    end
  end)
end

M.key = function()
  local identity = M.get()
  return identity.handle .. " " .. identity.token
end

M.display_name = function()
  return config.options.display_name or M.get().display_name
end

M.set_display_name = function(name)
  local identity = M.get()
  identity.display_name = name
  util.write_json(identity_path(), identity)
  require("friends.api").register(identity.handle, identity.token, name)
  if config.options.display_name and config.options.display_name ~= name then
    util.notify("display_name in setup() overrides :Friends name on restart", vim.log.levels.WARN)
  end
end

return M
