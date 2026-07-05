locals {
  worker_name        = "friends"
  hostname           = "friends.spader.zone"
  zone_name          = "spader.zone"
  compatibility_date = "2025-10-01"
  worker_bundle      = "${path.module}/../../backend/dist/worker.js"
}

data "cloudflare_zone" "spader_zone" {
  filter = {
    name = local.zone_name
  }
}

resource "cloudflare_workers_script" "friends" {
  account_id         = var.account_id
  script_name        = local.worker_name
  main_module        = "worker.js"
  content_file       = local.worker_bundle
  content_sha256     = filesha256(local.worker_bundle)
  compatibility_date = local.compatibility_date

  bindings = [
    {
      type = "d1"
      name = "DB"
      id   = cloudflare_d1_database.friends.id
    },
    {
      type         = "ratelimit"
      name         = "RATE_LIMITER"
      namespace_id = "1001"
      simple = {
        limit  = 60
        period = 60
      }
    },
  ]

  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      invocation_logs    = true
      head_sampling_rate = 1
      persist            = true
    }
  }
}

resource "cloudflare_workers_script_subdomain" "friends" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.friends.script_name
  enabled          = false
  previews_enabled = false
}

# Custom domains auto-create the DNS record and cert; the zone repo never
# needs to know about this hostname.
resource "cloudflare_workers_custom_domain" "friends" {
  account_id = var.account_id
  hostname   = local.hostname
  service    = cloudflare_workers_script.friends.script_name
  zone_id    = data.cloudflare_zone.spader_zone.id
  zone_name  = local.zone_name
}

resource "local_file" "wrangler_json" {
  filename = "${path.module}/../../backend/wrangler.json"
  content = templatefile("${path.module}/wrangler.json.template", {
    worker_name        = local.worker_name
    compatibility_date = local.compatibility_date
    d1_id              = cloudflare_d1_database.friends.id
  })
}

output "url" {
  value = "https://${local.hostname}/api"
}

output "worker_name" {
  value = cloudflare_workers_script.friends.script_name
}

output "d1_database_id" {
  value = cloudflare_d1_database.friends.id
}
