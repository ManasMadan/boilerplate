output "zone_id" {
  value = local.zone_id
}

output "storage" {
  description = "S3-compatible storage for the app-secrets module."
  sensitive   = true
  value = {
    endpoint          = "https://${var.account_id}.r2.cloudflarestorage.com"
    region            = "auto"
    bucket            = cloudflare_r2_bucket.uploads.name
    access_key_id     = cloudflare_api_token.storage.id
    secret_access_key = sha256(cloudflare_api_token.storage.value)
    public_origin     = "https://${var.account_id}.r2.cloudflarestorage.com"
  }
}

output "dns_api_token" {
  description = "For external-dns and cert-manager (platform-cloudflare-api-token)."
  sensitive   = true
  value       = cloudflare_api_token.dns.value
}

output "turnstile" {
  sensitive = true
  value = var.turnstile ? {
    site_key   = cloudflare_turnstile_widget.captcha[0].sitekey
    secret_key = cloudflare_turnstile_widget.captcha[0].secret
  } : null
}
