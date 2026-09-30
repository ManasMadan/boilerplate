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

variable "observability" {
  description = "Run Jaeger, Prometheus and Grafana on this cluster (off suits a small single node)."
  type        = bool
  default     = false
}

variable "managed_waf" {
  description = "Cloudflare's managed WAF rules on the zone (needs a Pro plan or higher)."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------- nodes

variable "nodes" {
  description = "The machines, by node name (see modules/k3s)."
  type = map(object({
    address         = string
    private_address = optional(string)
    user            = optional(string, "root")
    role            = optional(string, "server")
    labels          = optional(map(string), {})
    taints          = optional(list(string), [])
  }))
}

variable "ssh_private_key" {
  description = "The key OpenTofu installs k3s with (TF_VAR_ssh_private_key)."
  type        = string
  default     = null
  sensitive   = true
}

variable "install_over_ssh" {
  description = "Off when the machines are created with the cloud_init output instead (see the README)."
  type        = bool
  default     = true
}

variable "api_host" {
  description = "A DNS name or virtual IP in front of the servers for the Kubernetes API; defaults to the first server's address."
  type        = string
  default     = null
}

variable "flannel_backend" {
  description = "vxlan on a private network, wireguard-native when nodes reach each other over the internet."
  type        = string
  default     = "vxlan"
}

variable "origin_ips" {
  description = "Where Cloudflare sends the site's traffic; defaults to every node's address."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------- mail

variable "mail" {
  description = <<-EOT
    The mail server's DNS, or null until it's set up.
      node                the node it runs on (labelled boilerplate.dev/mail=true): its
                          address is the MX host's, and its reverse DNS must be the host
      host                default mail.<domain>
      ipv6                the node's IPv6 address, if it has one
      domain              the domain mail is sent from (default: the zone)
      dkim_selector, dkim_public_key, dkim_algorithm, dmarc_policy, dmarc_report_email
                          see modules/cloudflare
  EOT
  type = object({
    node               = string
    host               = optional(string)
    ipv6               = optional(string)
    domain             = optional(string)
    dkim_selector      = optional(string)
    dkim_public_key    = string
    dkim_algorithm     = optional(string)
    dmarc_policy       = optional(string)
    dmarc_report_email = string
  })
  default = null
  validation {
    condition     = var.mail == null || try(contains(keys(var.nodes), var.mail.node), false)
    error_message = "mail.node is one of the nodes."
  }
}

# ---------------------------------------------------------------------------- secrets

variable "sops_age_key" {
  description = "The environment's age private key, for Argo CD to decrypt its SOPS secrets (TF_VAR_sops_age_key)."
  type        = string
  sensitive   = true
}

variable "sops_preview_age_key" {
  description = "With previews = true: the previews' own age private key (TF_VAR_sops_preview_age_key)."
  type        = string
  sensitive   = true
  default     = null
}

variable "state_passphrase" {
  description = "Encrypts state and plans (TF_VAR_state_passphrase, at least 16 characters)."
  type        = string
  sensitive   = true
}
