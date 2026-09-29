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

# ---------------------------------------------------------------------------- AWS

variable "region" {
  type = string
}

variable "state_kms_key_id" {
  description = "The KMS key that encrypts this state (create it once, outside this root)."
  type        = string
}

variable "nodes" {
  type = object({
    instance_types = list(string)
    ami_type       = string
    min_size       = number
    max_size       = number
    desired_size   = number
  })
  default = null
}

variable "database" {
  type = object({
    instance_class        = string
    allocated_storage     = number
    max_allocated_storage = number
    multi_az              = bool
    deletion_protection   = bool
    backup_retention_days = number
  })
  default = null
}
