# The same outputs as the aws and gcp modules.

output "cluster" {
  # The provider marks the whole kubeconfig sensitive; the API's address and CA
  # certificate aren't secrets (the credentials in it are, and stay out of here).
  value = {
    name           = azurerm_kubernetes_cluster.this.name
    host           = nonsensitive(data.azurerm_kubernetes_cluster.this.kube_config[0].host)
    ca_certificate = nonsensitive(base64decode(data.azurerm_kubernetes_cluster.this.kube_config[0].cluster_ca_certificate))
  }
}

output "database" {
  sensitive = true
  value = {
    host           = azurerm_postgresql_flexible_server.this.fqdn
    port           = 5432
    name           = azurerm_postgresql_flexible_server_database.app.name
    admin_username = azurerm_postgresql_flexible_server.this.administrator_login
    admin_password = random_password.database_admin.result
    tls            = true
  }
}

output "valkey" {
  sensitive = true
  value = {
    host     = azurerm_managed_redis.this.hostname
    port     = azurerm_managed_redis.this.default_database[0].port
    password = azurerm_managed_redis.this.default_database[0].primary_access_key
    tls      = true
  }
}

output "key_vault_id" {
  description = "Where the secrets module writes (after the writer role assignment)."
  value       = azurerm_key_vault.this.id
  depends_on  = [azurerm_role_assignment.secrets_writer]
}

output "cluster_annotations" {
  description = "For the platform ApplicationSet (see deploy/README.md)."
  value = {
    cloud                 = "azure"
    "secret-store"        = "azure"
    "azure-vault-url"     = azurerm_key_vault.this.vault_uri
    "azure-eso-client-id" = azurerm_user_assigned_identity.external_secrets.client_id
  }
}
