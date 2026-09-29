# One environment on Azure: the same as the aws root, with AKS, Flexible Server and
# Azure Managed Redis.
#
#   tofu init -backend-config=backend-staging.hcl
#   tofu apply -var-file=staging.tfvars
#
# Credentials come from the environment: `az login` (or workload identity federation in
# CI), CLOUDFLARE_API_TOKEN, and kubelogin for the cluster.

locals {
  name           = "boilerplate-${var.environment}"
  prefix         = "${local.name}-"
  preview_prefix = "boilerplate-preview-"
  # Entra ID sign-in to AKS (the fixed id of the AKS server application).
  kubernetes_exec = {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "kubelogin"
    args        = ["get-token", "--login", "azurecli", "--server-id", "6dae42f8-4368-4678-94ff-3960e28e3630"]
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id
  features {}
}

provider "cloudflare" {}

provider "helm" {
  kubernetes = {
    host                   = module.cloud.cluster.host
    cluster_ca_certificate = module.cloud.cluster.ca_certificate
    exec                   = local.kubernetes_exec
  }
}

provider "kubernetes" {
  host                   = module.cloud.cluster.host
  cluster_ca_certificate = module.cloud.cluster.ca_certificate
  exec {
    api_version = local.kubernetes_exec.api_version
    command     = local.kubernetes_exec.command
    args        = local.kubernetes_exec.args
  }
}
module "cloud" {
  source   = "../../modules/azure"
  name     = local.name
  location = var.location
  nodes    = var.nodes
  database = var.database
}

module "cloudflare" {
  source     = "../../modules/cloudflare"
  account_id = var.cloudflare_account_id
  zone_name  = var.domain
  name       = local.name
  site_hosts = var.previews ? [var.site_host, "preview.${var.domain}"] : [var.site_host]
}

module "app_secrets" {
  source          = "../../modules/app-secrets"
  key_prefix      = local.prefix
  database        = module.cloud.database
  valkey          = module.cloud.valkey
  storage         = module.cloudflare.storage
  turnstile       = module.cloudflare.turnstile
  service_secrets = var.service_secrets
}

module "preview_secrets" {
  source          = "../../modules/app-secrets"
  count           = var.previews ? 1 : 0
  key_prefix      = local.preview_prefix
  include_data    = false
  storage         = module.cloudflare.storage
  turnstile       = module.cloudflare.turnstile
  service_secrets = var.preview_service_secrets
}

locals {
  platform_secrets = merge(
    { "${local.prefix}cloudflare-api-token" = jsonencode({ token = module.cloudflare.dns_api_token }) },
    var.previews ? { "${local.prefix}github-token" = jsonencode({ token = var.github_token }) } : {},
  )
}

module "secrets" {
  source       = "../../modules/azure/secrets"
  key_vault_id = module.cloud.key_vault_id
  names = concat(
    module.app_secrets.secret_names,
    var.previews ? module.preview_secrets[0].secret_names : [],
    ["${local.prefix}cloudflare-api-token"],
    var.previews ? ["${local.prefix}github-token"] : [],
  )
  values = merge(
    module.app_secrets.secrets,
    var.previews ? module.preview_secrets[0].secrets : {},
    local.platform_secrets,
  )
}

module "bootstrap" {
  source       = "../../modules/bootstrap"
  cluster_name = "azure-${var.environment}"
  environment  = var.environment
  previews     = var.previews
  cluster_annotations = merge(module.cloud.cluster_annotations, {
    domain          = var.domain
    "tls-email"     = var.tls_email
    dns01           = "cloudflare"
    "image-policy"  = tostring(var.environment == "production")
    "secret-prefix" = local.prefix
  })
  # External Secrets finds its secrets as soon as it starts.
  depends_on = [module.secrets]
}
