# The whole environment wired together, against mocked providers: every secret the
# charts read is written, and the cluster describes itself for the ApplicationSets.

mock_provider "azurerm" {
  override_data {
    target = module.cloud.data.azurerm_client_config.current
    values = {
      tenant_id = "00000000-0000-0000-0000-000000000001"
      object_id = "00000000-0000-0000-0000-000000000002"
    }
  }
  override_data {
    target = module.cloud.data.azurerm_kubernetes_cluster.this
    values = {
      kube_config = [{
        host                   = "https://boilerplate-production.hcp.westeurope.azmk8s.io:443"
        cluster_ca_certificate = "Y2EtY2VydGlmaWNhdGU="
        client_certificate     = ""
        client_key             = ""
        password               = ""
        username               = ""
      }]
    }
  }
  mock_resource "azurerm_resource_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/boilerplate-production" }
  }
  mock_resource "azurerm_virtual_network" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/boilerplate-production/providers/Microsoft.Network/virtualNetworks/boilerplate-production" }
  }
  mock_resource "azurerm_subnet" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/boilerplate-production/providers/Microsoft.Network/virtualNetworks/boilerplate-production/subnets/nodes" }
  }
  mock_resource "azurerm_private_dns_zone" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/boilerplate-production/providers/Microsoft.Network/privateDnsZones/zone" }
  }
  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/boilerplate-production/providers/Microsoft.KeyVault/vaults/boilerplateproduction"
      vault_uri = "https://boilerplateproduction.vault.azure.net/"
    }
  }
  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/boilerplate-production/providers/Microsoft.ManagedIdentity/userAssignedIdentities/eso"
      client_id    = "11111111-1111-1111-1111-111111111111"
      principal_id = "22222222-2222-2222-2222-222222222222"
    }
  }
  mock_resource "azurerm_kubernetes_cluster" {
    defaults = {
      id              = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/boilerplate-production/providers/Microsoft.ContainerService/managedClusters/boilerplate-production"
      oidc_issuer_url = "https://westeurope.oic.prod-aks.azure.com/tenant/issuer/"
    }
  }
  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/boilerplate-production/providers/Microsoft.DBforPostgreSQL/flexibleServers/boilerplate-production"
      fqdn = "boilerplate-production.postgres.database.azure.com"
    }
  }
  mock_resource "azurerm_managed_redis" {
    defaults = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/boilerplate-production/providers/Microsoft.Cache/redisEnterprise/boilerplate-production"
      hostname = "boilerplate-production.westeurope.redis.azure.net"
    }
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
  subscription_id       = "00000000-0000-0000-0000-000000000000"
  location              = "westeurope"
  state_passphrase      = "correct-horse-battery-staple"
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
    condition     = module.bootstrap.cluster_annotations["boilerplate.dev/cloud"] == "azure" && module.bootstrap.cluster_annotations["boilerplate.dev/domain"] == "example.com"
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
