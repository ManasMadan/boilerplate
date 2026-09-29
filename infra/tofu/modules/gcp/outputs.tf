# The same outputs as the aws and azure modules.

output "cluster" {
  value = {
    name           = google_container_cluster.this.name
    host           = "https://${data.google_container_cluster.this.endpoint}"
    ca_certificate = base64decode(data.google_container_cluster.this.master_auth[0].cluster_ca_certificate)
  }
}

output "database" {
  sensitive = true
  value = {
    host           = google_sql_database_instance.postgres.private_ip_address
    port           = 5432
    name           = google_sql_database.app.name
    admin_username = google_sql_user.admin.name
    admin_password = random_password.database_admin.result
    tls            = true
  }
}

output "valkey" {
  sensitive = true
  value = {
    host     = google_redis_instance.valkey.host
    port     = google_redis_instance.valkey.port
    password = google_redis_instance.valkey.auth_string
    tls      = false
  }
}

output "cluster_annotations" {
  description = "For the platform ApplicationSet (see deploy/README.md)."
  value = {
    cloud          = "gcp"
    "secret-store" = "gcp"
    "gcp-project"  = var.project_id
  }
}
