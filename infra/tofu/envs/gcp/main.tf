# One environment on Google Cloud: the same as the aws root, with GKE and Cloud SQL.
#
#   tofu init -backend-config=backend-staging.hcl
#   tofu apply -var-file=staging.tfvars
#
# Credentials come from the environment: gcloud application-default credentials (or
# workload identity federation in CI) and CLOUDFLARE_API_TOKEN.

locals {
  name           = "boilerplate-${var.environment}"
  prefix         = "${local.name}-"
  preview_prefix = "boilerplate-preview-"
}

provider "google" {
  project = var.project_id
  region  = var.region
  default_labels = {
    project     = "boilerplate"
    environment = var.environment
  }
}

provider "cloudflare" {}

data "google_client_config" "current" {}

provider "helm" {
  kubernetes = {
    host                   = module.cloud.cluster.host
    cluster_ca_certificate = module.cloud.cluster.ca_certificate
    token                  = data.google_client_config.current.access_token
  }
}

provider "kubernetes" {
  host                   = module.cloud.cluster.host
  cluster_ca_certificate = module.cloud.cluster.ca_certificate
  token                  = data.google_client_config.current.access_token
}
module "cloud" {
  source          = "../../modules/gcp"
  name            = local.name
  project_id      = var.project_id
  region          = var.region
  secret_prefixes = var.previews ? [local.prefix, local.preview_prefix] : [local.prefix]
  nodes           = var.nodes
  database        = var.database
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
  source     = "../../modules/gcp/secrets"
  project_id = var.project_id
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
  cluster_name = "gcp-${var.environment}"
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
