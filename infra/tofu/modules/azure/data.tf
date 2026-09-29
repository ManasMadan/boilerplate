# Managed Postgres 18 (Flexible Server) and Azure Managed Redis, on private addresses
# only, with TLS. The application's roles are created inside the cluster (the data
# chart's roles Job) with the admin login below.

resource "random_password" "database_admin" {
  length  = 40
  special = false
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                = var.name
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  version             = "18"
  sku_name            = var.database.sku_name
  storage_mb          = var.database.storage_mb

  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false

  administrator_login    = "boilerplate_admin"
  administrator_password = random_password.database_admin.result

  backup_retention_days = var.database.backup_retention_days
  dynamic "high_availability" {
    for_each = var.database.zone_redundant ? [1] : []
    content {
      mode = "ZoneRedundant"
    }
  }
  lifecycle {
    # Azure moves the primary between zones on failover.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }
  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

# Extensions must be allowed before the roles Job can create them.
resource "azurerm_postgresql_flexible_server_configuration" "extensions" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.this.id
  value     = "VECTOR,PG_TRGM"
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = "app"
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_managed_redis" "this" {
  name                      = var.name
  location                  = azurerm_resource_group.this.location
  resource_group_name       = azurerm_resource_group.this.name
  sku_name                  = var.valkey.sku_name
  high_availability_enabled = var.valkey.high_availability
  public_network_access     = "Disabled"
  default_database {
    access_keys_authentication_enabled = true
    client_protocol                    = "Encrypted"
    # One logical Redis: BullMQ's multi-key scripts stay on one node.
    clustering_policy = "NoCluster"
    # BullMQ keeps its queues here: never evict a key.
    eviction_policy = "NoEviction"
  }
}

resource "azurerm_private_endpoint" "redis" {
  name                = "${var.name}-redis"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  subnet_id           = azurerm_subnet.endpoints.id
  private_service_connection {
    name                           = "redis"
    private_connection_resource_id = azurerm_managed_redis.this.id
    subresource_names              = ["redisEnterprise"]
    is_manual_connection           = false
  }
  private_dns_zone_group {
    name                 = "redis"
    private_dns_zone_ids = [azurerm_private_dns_zone.redis.id]
  }
}
