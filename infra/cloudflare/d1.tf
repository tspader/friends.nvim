resource "cloudflare_d1_database" "friends" {
  account_id = var.account_id
  name       = "friends"

  read_replication = {
    mode = "auto"
  }
}
