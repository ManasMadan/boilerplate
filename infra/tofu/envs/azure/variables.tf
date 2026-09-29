# The same variables in every cloud's root, plus that cloud's own (region, keys, …).

variable "environment" {
  description = "staging or production."
  type        = string
}

variable "domain" {
  description = "The Cloudflare zone the environment's hosts are in, e.g. example.com."
  type        = string
}

variable "site_host" {
  description = "The environment's public host, e.g. app.example.com (must match deploy/environments/<env>/stack.yaml)."
  type        = string
}

variable "cloudflare_account_id" {
  type = string
}

variable "tls_email" {
  description = "Where Let's Encrypt sends certificate expiry notices."
  type        = string
}

variable "previews" {
  description = "Host pull-request previews on this environment's cluster (normally staging)."
  type        = bool
  default     = false
}

variable "github_token" {
  description = "For the previews ApplicationSet to list pull requests (read-only, this repo)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "service_secrets" {
  description = "Provider credentials per service (Stripe, Resend, Twilio, Google, …), e.g. { api = { STRIPE_SECRET_KEY = \"…\" } }."
  type        = map(map(string))
  default     = {}
  sensitive   = true
}

variable "preview_service_secrets" {
  description = "The same for previews (test-mode keys)."
  type        = map(map(string))
  default     = {}
  sensitive   = true
}

# ---------------------------------------------------------------------------- Azure

variable "subscription_id" {
  type = string
}

variable "location" {
  type = string
}

variable "state_passphrase" {
  description = "Encrypts this state (at least 16 characters; TF_VAR_state_passphrase)."
  type        = string
  sensitive   = true
}

variable "nodes" {
  type = object({
    vm_size   = string
    min_count = number
    max_count = number
  })
  default = null
}

variable "database" {
  type = object({
    sku_name              = string
    storage_mb            = number
    zone_redundant        = bool
    backup_retention_days = number
  })
  default = null
}
