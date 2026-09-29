data "azurerm_client_config" "current" {}

resource "azurerm_kubernetes_cluster" "this" {
  name                = var.name
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  dns_prefix          = var.name

  default_node_pool {
    name                 = "default"
    vm_size              = var.nodes.vm_size
    vnet_subnet_id       = azurerm_subnet.nodes.id
    auto_scaling_enabled = true
    min_count            = var.nodes.min_count
    max_count            = var.nodes.max_count
    upgrade_settings {
      max_surge = "33%"
    }
  }

  identity {
    type = "SystemAssigned"
  }

  # The node pool above, sized by the cluster autoscaler (not node auto-provisioning).
  node_provisioning_profile {
    mode = "Manual"
  }

  # Azure CNI overlay with Cilium, which enforces the charts' NetworkPolicies.
  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_data_plane  = "cilium"
    network_policy      = "cilium"
    pod_cidr            = "192.168.0.0/16"
  }

  # Workload identity for External Secrets (and anything else granted an identity).
  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  # People and pipelines sign in with Entra ID and get Azure RBAC roles; no static
  # admin credentials exist.
  local_account_disabled = true
  azure_active_directory_role_based_access_control {
    azure_rbac_enabled = true
    tenant_id          = data.azurerm_client_config.current.tenant_id
  }

  dynamic "api_server_access_profile" {
    for_each = length(var.api_allowed_cidrs) > 0 ? [1] : []
    content {
      authorized_ip_ranges = var.api_allowed_cidrs
    }
  }
  automatic_upgrade_channel = "patch"
}

# Whoever runs `tofu apply` administers the cluster (to bootstrap Argo CD).
resource "azurerm_role_assignment" "cluster_admin" {
  scope                = azurerm_kubernetes_cluster.this.id
  role_definition_name = "Azure Kubernetes Service RBAC Cluster Admin"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Connection details for the outputs, read back once the cluster exists.
data "azurerm_kubernetes_cluster" "this" {
  name                = azurerm_kubernetes_cluster.this.name
  resource_group_name = azurerm_resource_group.this.name
}

# The environment's own vault: External Secrets may read it all (Key Vault can't scope
# access by name prefix), so nothing else shares it.
resource "azurerm_key_vault" "this" {
  name                       = substr(replace(var.name, "-", ""), 0, 24)
  location                   = azurerm_resource_group.this.location
  resource_group_name        = azurerm_resource_group.this.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = 30
}

# Whoever runs `tofu apply` writes the environment's secrets.
resource "azurerm_role_assignment" "secrets_writer" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_user_assigned_identity" "external_secrets" {
  name                = "${var.name}-external-secrets"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
}

resource "azurerm_federated_identity_credential" "external_secrets" {
  name                      = "external-secrets"
  user_assigned_identity_id = azurerm_user_assigned_identity.external_secrets.id
  issuer                    = azurerm_kubernetes_cluster.this.oidc_issuer_url
  subject                   = "system:serviceaccount:external-secrets:external-secrets"
  audience                  = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_assignment" "external_secrets" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.external_secrets.principal_id
}
