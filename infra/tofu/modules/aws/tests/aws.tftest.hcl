# Against mocked AWS and Helm APIs: the network, cluster, data stores and identities, and
# outputs in the shape every cloud module shares.

mock_provider "aws" {
  override_data {
    target = data.aws_availability_zones.available
    values = { names = ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }
  }
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_eks_cluster" {
    defaults = {
      endpoint              = "https://ABC.gr7.eu-west-1.eks.amazonaws.com"
      certificate_authority = [{ data = "Y2EtY2VydGlmaWNhdGU=" }]
      identity              = [{ oidc = [{ issuer = "https://oidc.eks.eu-west-1.amazonaws.com/id/ABC" }] }]
      arn                   = "arn:aws:eks:eu-west-1:123456789012:cluster/boilerplate-production"
    }
  }
  mock_data "aws_eks_addon_version" {
    defaults = { version = "v1.0.0-eksbuild.1" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", latest_version = 1 }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012", arn = "arn:aws:iam::123456789012:user/tofu" }
  }
  mock_data "aws_iam_session_context" {
    defaults = { issuer_arn = "arn:aws:iam::123456789012:user/tofu" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
}
mock_provider "helm" {}
mock_provider "time" {}
mock_provider "tls" {
  mock_data "tls_certificate" {
    defaults = {
      certificates = [{
        cert_pem             = "-----BEGIN CERTIFICATE-----"
        is_ca                = true
        max_path_length      = 0
        issuer               = "CN=mock"
        not_after            = "2030-01-01T00:00:00Z"
        not_before           = "2020-01-01T00:00:00Z"
        public_key_algorithm = "RSA"
        serial_number        = "1"
        sha1_fingerprint     = "9e99a48a9960b14926bb7f3b02e22da2b0ab7280"
        signature_algorithm  = "SHA256-RSA"
        subject              = "CN=mock"
        version              = 3
      }]
    }
  }
}

variables {
  name            = "boilerplate-production"
  region          = "eu-west-1"
  secret_prefixes = ["boilerplate-production-"]
}

run "puts_the_databases_on_private_networks_behind_tls" {
  command = plan
  assert {
    condition     = aws_db_instance.postgres.engine == "postgres" && aws_db_instance.postgres.engine_version == "18"
    error_message = "Postgres 18"
  }
  assert {
    condition     = aws_db_instance.postgres.publicly_accessible == false && aws_db_instance.postgres.storage_encrypted
    error_message = "the database must be private and encrypted"
  }
  assert {
    condition     = one([for p in aws_db_parameter_group.postgres.parameter : p.value if p.name == "rds.force_ssl"]) == "1"
    error_message = "connections must use TLS"
  }
  assert {
    condition     = aws_elasticache_replication_group.valkey.engine == "valkey" && aws_elasticache_replication_group.valkey.transit_encryption_enabled
    error_message = "Valkey with TLS"
  }
  assert {
    condition     = one([for p in aws_elasticache_parameter_group.valkey.parameter : p.value if p.name == "maxmemory-policy"]) == "noeviction"
    error_message = "BullMQ needs noeviction"
  }
}

run "keeps_the_database_unless_told_otherwise" {
  command = plan
  assert {
    condition     = aws_db_instance.postgres.deletion_protection && !aws_db_instance.postgres.skip_final_snapshot
    error_message = "production data must survive a destroy"
  }
}

run "fails_over_valkey_only_with_a_replica" {
  command = plan
  variables {
    valkey = { node_type = "cache.t4g.micro", replicas = 0 }
  }
  assert {
    condition     = !aws_elasticache_replication_group.valkey.automatic_failover_enabled && aws_elasticache_replication_group.valkey.num_cache_clusters == 1
    error_message = "a single node can't fail over"
  }
}

run "describes_itself_like_every_cloud_module" {
  command = apply
  assert {
    condition     = output.cluster_annotations == { cloud = "aws", "secret-store" = "aws", "aws-region" = "eu-west-1" }
    error_message = "cluster annotations"
  }
  assert {
    condition     = output.database.tls && output.database.name == "app" && output.database.admin_username == "boilerplate_admin"
    error_message = "database output"
  }
  assert {
    condition     = output.valkey.port == 6379 && output.valkey.tls
    error_message = "valkey output"
  }
  assert {
    condition     = toset(keys(output.cluster)) == toset(["name", "host", "ca_certificate"]) && output.cluster.ca_certificate == "ca-certificate"
    error_message = "cluster output shape (the CA decoded)"
  }
}
