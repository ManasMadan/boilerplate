# Managed Postgres 18 and Valkey, reachable only from the cluster's nodes, encrypted in
# transit and at rest. The application's roles are created inside the cluster (the data
# chart's roles Job) with the admin login below.

resource "random_password" "database_admin" {
  length  = 40
  special = false
}

resource "aws_security_group" "database" {
  name_prefix = "${var.name}-postgres-"
  vpc_id      = module.vpc.vpc_id
  ingress {
    description     = "Postgres from the cluster nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_parameter_group" "postgres" {
  name_prefix = "${var.name}-postgres18-"
  family      = "postgres18"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "postgres" {
  identifier_prefix     = "${var.name}-"
  engine                = "postgres"
  engine_version        = "18"
  instance_class        = var.database.instance_class
  allocated_storage     = var.database.allocated_storage
  max_allocated_storage = var.database.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "app"
  username = "boilerplate_admin"
  password = random_password.database_admin.result

  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.postgres.name
  publicly_accessible    = false

  multi_az                     = var.database.multi_az
  backup_retention_period      = var.database.backup_retention_days
  deletion_protection          = var.database.deletion_protection
  skip_final_snapshot          = !var.database.deletion_protection
  final_snapshot_identifier    = var.database.deletion_protection ? "${var.name}-final" : null
  auto_minor_version_upgrade   = true
  performance_insights_enabled = true
  apply_immediately            = false
}

resource "random_password" "valkey" {
  length  = 64
  special = false
}

resource "aws_security_group" "valkey" {
  name_prefix = "${var.name}-valkey-"
  vpc_id      = module.vpc.vpc_id
  ingress {
    description     = "Valkey from the cluster nodes"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_elasticache_subnet_group" "valkey" {
  name       = var.name
  subnet_ids = module.vpc.private_subnets
}

resource "aws_elasticache_replication_group" "valkey" {
  replication_group_id = var.name
  description          = "Queues, sessions, rate limits and caches for ${var.name}"
  engine               = "valkey"
  engine_version       = "8.1"
  node_type            = var.valkey.node_type
  num_cache_clusters   = 1 + var.valkey.replicas
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.valkey.name
  security_group_ids = [aws_security_group.valkey.id]

  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  auth_token                 = random_password.valkey.result

  automatic_failover_enabled = var.valkey.replicas > 0
  multi_az_enabled           = var.valkey.replicas > 0
  # BullMQ keeps its queues in Valkey: never evict a key.
  parameter_group_name = aws_elasticache_parameter_group.valkey.name
}

resource "aws_elasticache_parameter_group" "valkey" {
  name   = "${var.name}-valkey8"
  family = "valkey8"
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}
