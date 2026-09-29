# Against a mocked Cloudflare API: what gets created, and how tightly each token is scoped.

mock_provider "cloudflare" {
  override_data {
    target = data.cloudflare_zone.this
    values = { zone_id = "023e105f4ecef8ad9ca31a8372d0c353" }
  }
  override_data {
    target = data.cloudflare_api_token_permission_groups_list.this
    values = { result = [{ id = "perm-id", name = "permission", scopes = [] }] }
  }
  mock_resource "cloudflare_api_token" {
    defaults = { id = "token-id", value = "token-value" }
  }
  mock_resource "cloudflare_turnstile_widget" {
    defaults = { sitekey = "site-key", secret = "secret-key" }
  }
}

variables {
  account_id = "01a7362d577a6c3019a474fd6f485823"
  zone_name  = "example.com"
  name       = "boilerplate-production"
  site_hosts = ["app.example.com"]
}

run "hardens_the_zone" {
  command = apply
  assert {
    condition     = cloudflare_zone_setting.this["ssl"].value == "strict" && cloudflare_zone_setting.this["always_use_https"].value == "on"
    error_message = "the zone must use strict TLS and HTTPS only"
  }
  assert {
    condition     = length(cloudflare_ruleset.managed_waf) == 0
    error_message = "the managed WAF needs a paid plan, so it's opt-in"
  }
}

run "lets_the_site_upload_to_the_bucket" {
  command = apply
  assert {
    condition     = cloudflare_r2_bucket.uploads.name == "boilerplate-production-uploads"
    error_message = "bucket name"
  }
  assert {
    condition     = cloudflare_r2_bucket_cors.uploads.rules[0].allowed.origins == tolist(["https://app.example.com"])
    error_message = "only the site's origin may upload"
  }
}

run "scopes_each_token_to_what_it_needs" {
  command = apply
  assert {
    condition     = jsondecode(cloudflare_api_token.dns.policies[0].resources) == { "com.cloudflare.api.account.zone.023e105f4ecef8ad9ca31a8372d0c353" = "*" }
    error_message = "the DNS token must cover this zone only"
  }
  assert {
    condition     = jsondecode(cloudflare_api_token.storage.policies[0].resources) == { "com.cloudflare.edge.r2.bucket.01a7362d577a6c3019a474fd6f485823_default_boilerplate-production-uploads" = "*" }
    error_message = "the storage token must cover this bucket only"
  }
}

run "hands_out_r2_s3_credentials" {
  command = apply
  assert {
    condition     = output.storage.access_key_id == "token-id" && output.storage.secret_access_key == sha256("token-value")
    error_message = "R2's S3 credentials are the token id and the SHA-256 of its value"
  }
  assert {
    condition     = output.storage.endpoint == "https://01a7362d577a6c3019a474fd6f485823.r2.cloudflarestorage.com" && output.storage.region == "auto"
    error_message = "R2 endpoint and region"
  }
  assert {
    condition     = output.turnstile.site_key == "site-key"
    error_message = "Turnstile keys"
  }
}

run "can_skip_the_captcha_and_add_the_waf" {
  command = apply
  variables {
    turnstile   = false
    managed_waf = true
  }
  assert {
    condition     = output.turnstile == null && length(cloudflare_ruleset.managed_waf) == 1
    error_message = "optional parts"
  }
}

run "rejects_names_r2_refuses" {
  command = plan
  variables {
    name = "Boilerplate_Prod"
  }
  expect_failures = [var.name]
}
