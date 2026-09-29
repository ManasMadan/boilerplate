# Against a mocked Azure API: private data stores with TLS, enforced network policies,
# workload identity for External Secrets, and the outputs every cloud module shares.

mock_provider "azurerm" {
  override_data {
    target = data.azurerm_client_config.current
    values = {
      tenant_id = "00000000-0000-0000-0000-000000000001"
      object_id = "00000000-0000-0000-0000-000000000002"
    }
  }
  override_data {
    target = data.azurerm_kubernetes_cluster.this
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

variables {
  name     = "boilerplate-production"
  location = "westeurope"
}

run "keeps_data_private_and_encrypted" {
  command = plan
  assert {
    condition     = azurerm_postgresql_flexible_server.this.version == "18" && !azurerm_postgresql_flexible_server.this.public_network_access_enabled
    error_message = "a private Postgres 18"
  }
  assert {
    condition     = azurerm_postgresql_flexible_server_configuration.extensions.value == "VECTOR,PG_TRGM"
    error_message = "the roles Job needs these extensions allowed"
  }
  assert {
    condition     = azurerm_managed_redis.this.public_network_access == "Disabled" && azurerm_managed_redis.this.default_database[0].client_protocol == "Encrypted"
    error_message = "a private Redis with TLS"
  }
  assert {
    condition     = azurerm_managed_redis.this.default_database[0].eviction_policy == "NoEviction" && azurerm_managed_redis.this.default_database[0].clustering_policy == "NoCluster"
    error_message = "BullMQ needs no eviction and one logical Redis"
  }
}

run "enforces_network_policies_and_workload_identity" {
  command = plan
  assert {
    condition     = azurerm_kubernetes_cluster.this.network_profile[0].network_policy == "cilium"
    error_message = "Cilium enforces the charts' NetworkPolicies"
  }
  assert {
    condition     = azurerm_kubernetes_cluster.this.workload_identity_enabled && azurerm_kubernetes_cluster.this.oidc_issuer_enabled
    error_message = "External Secrets authenticates with workload identity"
  }
  assert {
    condition     = azurerm_kubernetes_cluster.this.local_account_disabled && azurerm_kubernetes_cluster.this.azure_active_directory_role_based_access_control[0].azure_rbac_enabled
    error_message = "cluster access goes through Entra ID and Azure RBAC only"
  }
  assert {
    condition     = azurerm_federated_identity_credential.external_secrets.subject == "system:serviceaccount:external-secrets:external-secrets"
    error_message = "the identity belongs to External Secrets' service account"
  }
  assert {
    condition     = azurerm_role_assignment.external_secrets.role_definition_name == "Key Vault Secrets User"
    error_message = "External Secrets reads, never writes"
  }
}

run "names_the_vault_within_azure_limits" {
  command = plan
  assert {
    condition     = azurerm_key_vault.this.name == "boilerplateproduction" && azurerm_key_vault.this.purge_protection_enabled
    error_message = "vault names are 3-24 letters and digits; secrets must survive deletion"
  }
}

run "describes_itself_like_every_cloud_module" {
  command = apply
  assert {
    condition = output.cluster_annotations == {
      cloud                 = "azure"
      "secret-store"        = "azure"
      "azure-vault-url"     = "https://boilerplateproduction.vault.azure.net/"
      "azure-eso-client-id" = "11111111-1111-1111-1111-111111111111"
    }
    error_message = "cluster annotations"
  }
  assert {
    condition     = output.cluster.host == "https://boilerplate-production.hcp.westeurope.azmk8s.io:443" && output.cluster.ca_certificate == "ca-certificate"
    error_message = "cluster output"
  }
  assert {
    condition     = output.database.host == "boilerplate-production.postgres.database.azure.com" && output.database.tls
    error_message = "database output"
  }
  assert {
    condition     = output.valkey.host == "boilerplate-production.westeurope.redis.azure.net" && output.valkey.tls
    error_message = "valkey output"
  }
}
