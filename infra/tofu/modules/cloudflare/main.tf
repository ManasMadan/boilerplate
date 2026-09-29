# Cloudflare in front of an environment: the zone's TLS settings (and optionally the
# managed WAF), the R2 bucket for uploads (the default object store on every cloud, S3
# API), and least-privilege API tokens for what runs in the cluster: DNS records and
# certificates (external-dns, cert-manager) and the bucket (the services).
#
# The provider's own token needs: Zone Settings Edit, Zone WAF Edit (for managed_waf),
# Workers R2 Storage Edit, Turnstile Sites Write, and API Tokens Write (to create the
# scoped tokens below).

data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}

locals {
  zone_id = data.cloudflare_zone.this.zone_id
  bucket  = "${var.name}-uploads"
}

# Full (strict) TLS to the origin, HTTPS only, modern TLS.
resource "cloudflare_zone_setting" "this" {
  for_each = {
    ssl              = "strict"
    always_use_https = "on"
    min_tls_version  = "1.2"
  }
  zone_id    = local.zone_id
  setting_id = each.key
  value      = each.value
}

resource "cloudflare_ruleset" "managed_waf" {
  count   = var.managed_waf ? 1 : 0
  zone_id = local.zone_id
  name    = "Managed WAF"
  kind    = "zone"
  phase   = "http_request_firewall_managed"
  rules = [{
    action      = "execute"
    expression  = "true"
    description = "Cloudflare Managed Ruleset"
    action_parameters = {
      # Cloudflare's published id for its Managed Ruleset.
      id = "efb7b8c949ac4650a09736fc376e9aee"
    }
  }]
}

resource "cloudflare_r2_bucket" "uploads" {
  account_id = var.account_id
  name       = local.bucket
}

# Browsers upload straight to the bucket (presigned requests) from the site.
resource "cloudflare_r2_bucket_cors" "uploads" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.uploads.name
  rules = [{
    allowed = {
      origins = [for host in var.site_hosts : "https://${host}"]
      methods = ["GET", "HEAD", "PUT", "POST"]
      headers = ["content-type", "content-length", "content-md5"]
    }
    max_age_seconds = 3600
  }]
}

data "cloudflare_api_token_permission_groups_list" "this" {
  for_each = toset(["Zone Read", "DNS Write", "Workers R2 Storage Bucket Item Write"])
  name     = each.key
}

locals {
  permission = { for name, groups in data.cloudflare_api_token_permission_groups_list.this : name => one(groups.result).id }
}

# external-dns and cert-manager: this zone's DNS records, nothing else.
resource "cloudflare_api_token" "dns" {
  name = "${var.name}-dns"
  policies = [{
    effect            = "allow"
    permission_groups = [{ id = local.permission["Zone Read"] }, { id = local.permission["DNS Write"] }]
    resources         = jsonencode({ "com.cloudflare.api.account.zone.${local.zone_id}" = "*" })
  }]
}

# The services: objects in the uploads bucket, nothing else. R2's S3 credentials are the
# token's id and the SHA-256 of its value.
resource "cloudflare_api_token" "storage" {
  name = "${var.name}-storage"
  policies = [{
    effect            = "allow"
    permission_groups = [{ id = local.permission["Workers R2 Storage Bucket Item Write"] }]
    resources         = jsonencode({ "com.cloudflare.edge.r2.bucket.${var.account_id}_default_${local.bucket}" = "*" })
  }]
}

resource "cloudflare_turnstile_widget" "captcha" {
  count      = var.turnstile ? 1 : 0
  account_id = var.account_id
  name       = var.name
  domains    = var.site_hosts
  mode       = "managed"
}
