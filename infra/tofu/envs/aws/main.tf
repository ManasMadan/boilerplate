# One environment on AWS: the cloud's resources, Cloudflare in front, every secret in
# Secrets Manager, and the cluster handed to Argo CD. The gcp and azure roots are the
# same apart from the cloud module and provider authentication.
#
#   tofu init -backend-config=backend-staging.hcl
#   tofu apply -var-file=staging.tfvars
#
# Credentials come from the environment: AWS (profile or OIDC in CI) and
# CLOUDFLARE_API_TOKEN (see modules/cloudflare for its permissions).

locals {
  name           = "boilerplate-${var.environment}"
  prefix         = "${local.name}-"
  preview_prefix = "boilerplate-preview-"
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "boilerplate", environment = var.environment }
  }
}

provider "cloudflare" {}

locals {
  kubernetes = {
    host                   = module.cloud.cluster.host
    cluster_ca_certificate = module.cloud.cluster.ca_certificate
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.cloud.cluster.name, "--region", var.region]
    }
  }
}

provider "helm" {
  kubernetes = local.kubernetes
}

provider "kubernetes" {
  host                   = local.kubernetes.host
  cluster_ca_certificate = local.kubernetes.cluster_ca_certificate
  exec {
    api_version = local.kubernetes.exec.api_version
    command     = local.kubernetes.exec.command
    args        = local.kubernetes.exec.args
  }
}

module "cloud" {
  source          = "../../modules/aws"
  name            = local.name
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
  source = "../../modules/aws/secrets"
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
  cluster_name = "aws-${var.environment}"
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
