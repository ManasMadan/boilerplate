# Managed Postgres 18 (Cloud SQL) and Memorystore, on private addresses only. The
# application's roles are created inside the cluster (the data chart's roles Job) with
# the admin login below.

resource "random_password" "database_admin" {
  length  = 40
  special = false
}

resource "google_sql_database_instance" "postgres" {
  project             = var.project_id
  name                = var.name
  region              = var.region
  database_version    = "POSTGRES_18"
  deletion_protection = var.database.deletion_protection

  settings {
    tier              = var.database.tier
    edition           = "ENTERPRISE"
    availability_type = var.database.high_availability ? "REGIONAL" : "ZONAL"
    disk_size         = var.database.disk_size_gb
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.this.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    insights_config {
      query_insights_enabled = true
    }
  }
  depends_on = [google_service_networking_connection.services]
}

resource "google_sql_database" "app" {
  project  = var.project_id
  instance = google_sql_database_instance.postgres.name
  name     = "app"
}

resource "google_sql_user" "admin" {
  project  = var.project_id
  instance = google_sql_database_instance.postgres.name
  name     = "boilerplate_admin"
  password = random_password.database_admin.result
}

# Memorystore's TLS certificates come from a private Google CA that the services'
# Redis clients don't trust, so traffic stays on the private network with AUTH only
# (see infra/tofu/README.md).
resource "google_redis_instance" "valkey" {
  project                 = var.project_id
  name                    = var.name
  region                  = var.region
  tier                    = var.valkey.high_availability ? "STANDARD_HA" : "BASIC"
  memory_size_gb          = var.valkey.memory_size_gb
  redis_version           = "REDIS_7_2"
  authorized_network      = google_compute_network.this.id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  auth_enabled            = true
  transit_encryption_mode = "DISABLED"
  # BullMQ keeps its queues here: never evict a key.
  redis_configs = {
    maxmemory-policy = "noeviction"
  }
  depends_on = [google_service_networking_connection.services]
}
