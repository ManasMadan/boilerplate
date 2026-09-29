variable "key_prefix" {
  description = "Prefix of every remote secret name, e.g. boilerplate-production- (dashes only: every cloud's secret manager accepts them)."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9-]*$", var.key_prefix))
    error_message = "Use lowercase letters, digits and dashes only."
  }
}

variable "include_data" {
  description = "Write the database and Valkey secrets. Off for previews, which run their own in-cluster Postgres and Valkey with generated credentials."
  type        = bool
  default     = true
}

variable "database" {
  description = "The managed Postgres the cloud module created, and its admin login (unused without include_data)."
  type = object({
    host           = string
    port           = number
    name           = string
    admin_username = string
    admin_password = string
    tls            = bool
  })
  sensitive = true
  default   = null
}

variable "valkey" {
  description = "The managed Valkey/Redis the cloud module created."
  type = object({
    host     = string
    port     = number
    password = string
    tls      = bool
  })
  sensitive = true
  default   = null
}

variable "storage" {
  description = "S3-compatible object storage for uploads (R2 by default, from the cloudflare module)."
  type = object({
    endpoint          = string
    region            = string
    bucket            = string
    access_key_id     = string
    secret_access_key = string
    # The origin browsers upload to and load files from (the web app's CSP allows it).
    public_origin = string
  })
  sensitive = true
}

variable "turnstile" {
  description = "Cloudflare Turnstile keys for the sign-up and sign-in captcha (null: off)."
  type = object({
    site_key   = string
    secret_key = string
  })
  default   = null
  sensitive = true
}

variable "service_secrets" {
  description = <<-EOT
    Provider credentials this module can't create, per service, merged over what it
    generates: e.g. { api = { STRIPE_SECRET_KEY = "…" }, notifications = { RESEND_API_KEY = "…" } }.
  EOT
  type        = map(map(string))
  default     = {}
  sensitive   = true
}
