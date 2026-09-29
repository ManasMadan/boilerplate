# The whole environment wired together, against mocked providers: every secret the
# charts read is written, and the cluster describes itself for the ApplicationSets.

mock_provider "google" {
  override_data {
    target = data.google_client_config.current
    values = { access_token = "token" }
  }
  override_data {
    target = module.cloud.data.google_project.this
    values = { number = "123456789" }
  }
  override_data {
    target = module.cloud.data.google_container_cluster.this
    values = {
      endpoint    = "34.1.2.3"
      master_auth = [{ cluster_ca_certificate = "Y2EtY2VydGlmaWNhdGU=", client_certificate = "", client_key = "", client_certificate_config = [] }]
    }
  }
  mock_resource "google_compute_network" {
    defaults = { id = "projects/example-project/global/networks/boilerplate-production" }
  }
  mock_resource "google_sql_database_instance" {
    defaults = { private_ip_address = "10.100.0.3" }
  }
  mock_resource "google_redis_instance" {
    defaults = { host = "10.100.1.4", port = 6379, auth_string = "auth" }
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
mock_provider "helm" {}
mock_provider "kubernetes" {}

variables {
  environment           = "staging"
  domain                = "example.com"
  site_host             = "staging.example.com"
  cloudflare_account_id = "01a7362d577a6c3019a474fd6f485823"
  tls_email             = "ops@example.com"
  previews              = true
  github_token          = "ghp_x"
  project_id            = "example-project"
  region                = "europe-west1"
  state_kms_key         = "projects/example-project/locations/europe-west1/keyRings/tofu/cryptoKeys/state"
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
    condition     = module.bootstrap.cluster_annotations["boilerplate.dev/cloud"] == "gcp" && module.bootstrap.cluster_annotations["boilerplate.dev/domain"] == "example.com"
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
