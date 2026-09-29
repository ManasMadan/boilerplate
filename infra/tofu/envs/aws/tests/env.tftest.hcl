# The whole environment wired together, against mocked providers: every secret the
# charts read is written, and the cluster describes itself for the ApplicationSets.

mock_provider "aws" {
  override_data {
    target = module.cloud.data.aws_availability_zones.available
    values = { names = ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }
  }
  override_data {
    target = module.cloud.data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_eks_cluster" {
    defaults = {
      endpoint              = "https://ABC.gr7.eu-west-1.eks.amazonaws.com"
      certificate_authority = [{ data = "Y2EtY2VydGlmaWNhdGU=" }]
      identity              = [{ oidc = [{ issuer = "https://oidc.eks.eu-west-1.amazonaws.com/id/ABC" }] }]
      arn                   = "arn:aws:eks:eu-west-1:123456789012:cluster/boilerplate-production"
    }
  }
  mock_data "aws_eks_addon_version" {
    defaults = { version = "v1.0.0-eksbuild.1" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", latest_version = 1 }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012", arn = "arn:aws:iam::123456789012:user/tofu" }
  }
  mock_data "aws_iam_session_context" {
    defaults = { issuer_arn = "arn:aws:iam::123456789012:user/tofu" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
}
mock_provider "cloudflare" {
  override_data {
    target = module.cloudflare.data.cloudflare_zone.this
    values = { zone_id = "023e105f4ecef8ad9ca31a8372d0c353" }
  }
  override_data {
    target = module.cloudflare.data.cloudflare_api_token_permission_groups_list.this
    values = { result = [{ id = "perm-id", name = "permission", scopes = [] }] }
  }
  mock_resource "cloudflare_api_token" {
    defaults = { id = "token-id", value = "token-value" }
  }
  mock_resource "cloudflare_turnstile_widget" {
    defaults = { sitekey = "site-key", secret = "secret-key" }
  }
}
mock_provider "tls" {
  mock_data "tls_certificate" {
    defaults = {
      certificates = [{
        cert_pem             = "-----BEGIN CERTIFICATE-----"
        is_ca                = true
        max_path_length      = 0
        issuer               = "CN=mock"
        not_after            = "2030-01-01T00:00:00Z"
        not_before           = "2020-01-01T00:00:00Z"
        public_key_algorithm = "RSA"
        serial_number        = "1"
        sha1_fingerprint     = "9e99a48a9960b14926bb7f3b02e22da2b0ab7280"
        signature_algorithm  = "SHA256-RSA"
        subject              = "CN=mock"
        version              = 3
      }]
    }
  }
}
mock_provider "helm" {}
mock_provider "kubernetes" {}
mock_provider "time" {}

variables {
  environment           = "staging"
  region                = "eu-west-1"
  domain                = "example.com"
  site_host             = "staging.example.com"
  cloudflare_account_id = "01a7362d577a6c3019a474fd6f485823"
  tls_email             = "ops@example.com"
  state_kms_key_id      = "arn:aws:kms:eu-west-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  previews              = true
  github_token          = "ghp_x"
}

run "writes_every_secret_the_charts_read" {
  command = apply
  assert {
    condition = alltrue([for name in [
      "boilerplate-staging-app-api", "boilerplate-staging-admin", "boilerplate-staging-valkey",
      "boilerplate-staging-api", "boilerplate-staging-cloudflare-api-token",
      "boilerplate-staging-github-token", "boilerplate-preview-api",
    ] : contains(keys(module.secrets.names_written), name)])
    error_message = "a secret the charts read is missing"
  }
  assert {
    condition     = !contains(keys(module.secrets.names_written), "boilerplate-preview-app-api")
    error_message = "previews make their own database credentials"
  }
}

run "describes_the_cluster_for_the_applicationsets" {
  command = apply
  assert {
    condition     = module.bootstrap.cluster_annotations["boilerplate.dev/secret-prefix"] == "boilerplate-staging-"
    error_message = "the platform config reads its secrets under this prefix"
  }
  assert {
    condition     = module.bootstrap.cluster_annotations["boilerplate.dev/image-policy"] == "false" && module.bootstrap.cluster_annotations["boilerplate.dev/previews"] == "true"
    error_message = "staging hosts previews and admits unsigned images"
  }
  assert {
    condition     = module.bootstrap.cluster_annotations["boilerplate.dev/cloud"] == "aws" && module.bootstrap.cluster_annotations["boilerplate.dev/domain"] == "example.com"
    error_message = "cloud and domain"
  }
}

run "keeps_production_to_signed_images_and_no_previews" {
  command = apply
  variables {
    environment = "production"
    site_host   = "app.example.com"
    previews    = false
  }
  assert {
    condition     = module.bootstrap.cluster_annotations["boilerplate.dev/image-policy"] == "true" && module.bootstrap.cluster_annotations["boilerplate.dev/previews"] == "false"
    error_message = "production only runs signed images"
  }
  assert {
    condition     = !contains(keys(module.secrets.names_written), "boilerplate-production-github-token")
    error_message = "no GitHub token without previews"
  }
}
