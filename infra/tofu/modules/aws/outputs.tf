# The same outputs as the gcp and azure modules, so an environment's root composes any
# of them identically.

output "cluster" {
  value = {
    name           = module.eks.cluster_name
    host           = module.eks.cluster_endpoint
    ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  }
}

output "database" {
  sensitive = true
  value = {
    host           = aws_db_instance.postgres.address
    port           = aws_db_instance.postgres.port
    name           = aws_db_instance.postgres.db_name
    admin_username = aws_db_instance.postgres.username
    admin_password = random_password.database_admin.result
    tls            = true
  }
}

output "valkey" {
  sensitive = true
  value = {
    host     = aws_elasticache_replication_group.valkey.primary_endpoint_address
    port     = 6379
    password = random_password.valkey.result
    tls      = true
  }
}

output "cluster_annotations" {
  description = "For the platform ApplicationSet (see deploy/README.md)."
  value = {
    cloud          = "aws"
    "secret-store" = "aws"
    "aws-region"   = var.region
  }
}
