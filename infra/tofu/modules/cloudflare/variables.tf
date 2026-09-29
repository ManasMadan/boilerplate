variable "account_id" {
  description = "The Cloudflare account."
  type        = string
}

variable "zone_name" {
  description = "The DNS zone (already on Cloudflare), e.g. example.com."
  type        = string
}

variable "name" {
  description = "Name for this environment's resources, e.g. boilerplate-production."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,40}$", var.name))
    error_message = "Lowercase letters, digits and dashes (it names an R2 bucket)."
  }
}

variable "site_hosts" {
  description = "The environment's public hosts: browsers upload from them, and the captcha runs on them."
  type        = list(string)
}

variable "turnstile" {
  description = "Create a Turnstile widget for the sign-up and sign-in captcha."
  type        = bool
  default     = true
}

variable "managed_waf" {
  description = "Run Cloudflare's managed WAF rules on the zone (needs a Pro plan or higher)."
  type        = bool
  default     = false
}
