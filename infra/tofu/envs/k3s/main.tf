# One environment: k3s on your machines, Cloudflare in front, and the cluster handed to
# Argo CD, which deploys the rest from this repository. Staging and production are this
# same root with their own tfvars and state.
#
#   tofu init -backend-config=backend-staging.hcl
#   tofu apply -var-file=staging.tfvars
#
# Credentials come from the environment: CLOUDFLARE_API_TOKEN (see modules/cloudflare
# for its permissions), TF_VAR_ssh_private_key, TF_VAR_sops_age_key and
# TF_VAR_state_passphrase.

locals {
  name = "boilerplate-${var.environment}"

  # The mail server runs on the node that its DNS points at (outgoing mail leaves from
  # the address of the node it's sent from, which SPF and reverse DNS vouch for).
  nodes = { for name, node in var.nodes : name => merge(node, {
    labels = merge(node.labels, var.mail != null && try(var.mail.node == name, false) ? { "boilerplate.dev/mail" = "true" } : {})
  }) }
  mail_host = var.mail == null ? null : coalesce(var.mail.host, "mail.${var.domain}")
}

provider "cloudflare" {}

provider "helm" {
  kubernetes = module.k3s.kubernetes
}

provider "kubernetes" {
  host                   = module.k3s.kubernetes.host
  cluster_ca_certificate = module.k3s.kubernetes.cluster_ca_certificate
  client_certificate     = module.k3s.kubernetes.client_certificate
  client_key             = module.k3s.kubernetes.client_key
}

module "k3s" {
  source           = "../../modules/k3s"
  name             = local.name
  nodes            = local.nodes
  ssh_private_key  = var.ssh_private_key
  install_over_ssh = var.install_over_ssh
  api_host         = var.api_host
  flannel_backend  = var.flannel_backend
}

module "cloudflare" {
  source       = "../../modules/cloudflare"
  account_id   = var.cloudflare_account_id
  zone_name    = var.domain
  name         = local.name
  site_hosts   = [var.site_host]
  origin_ips   = length(var.origin_ips) > 0 ? var.origin_ips : [for node in var.nodes : node.address]
  preview_host = var.previews ? "preview.${var.domain}" : null
  managed_waf  = var.managed_waf
  mail = var.mail == null ? null : {
    host               = local.mail_host
    ipv4               = var.nodes[var.mail.node].address
    ipv6               = var.mail.ipv6
    domain             = var.mail.domain
    dkim_selector      = var.mail.dkim_selector
    dkim_public_key    = var.mail.dkim_public_key
    dkim_algorithm     = var.mail.dkim_algorithm
    dmarc_policy       = var.mail.dmarc_policy
    dmarc_report_email = var.mail.dmarc_report_email
  }
}

module "bootstrap" {
  source        = "../../modules/bootstrap"
  cluster_name  = var.environment
  environment   = var.environment
  previews      = var.previews
  observability = var.observability
  sops_age_key  = var.sops_age_key
  cluster_annotations = merge(
    {
      domain         = var.domain
      "tls-email"    = var.tls_email
      dns01          = "cloudflare"
      "image-policy" = tostring(var.environment == "production")
    },
    local.mail_host == null ? {} : { "mail-host" = local.mail_host },
  )
  # Argo CD goes on once every node is installed.
  depends_on = [module.k3s]
}
