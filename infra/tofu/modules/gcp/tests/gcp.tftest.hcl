# Against a mocked Google API: private data stores, enforced network policies, scoped
# secret access, and the outputs every cloud module shares.

mock_provider "google" {
  override_data {
    target = data.google_project.this
    values = { number = "123456789" }
  }
  override_data {
    target = data.google_container_cluster.this
    values = {
      endpoint    = "34.1.2.3"
      master_auth = [{ cluster_ca_certificate = "Y2EtY2VydGlmaWNhdGU=", client_certificate = "", client_key = "", client_certificate_config = [] }]
    }
  }
  mock_resource "google_compute_network" {
    defaults = { id = "projects/example-project/global/networks/boilerplate-production" }
  }
  mock_resource "google_sql_database_instance" {
    defaults = { private_ip_address = "10.100.0.3" }
  }
  mock_resource "google_redis_instance" {
    defaults = { host = "10.100.1.4", port = 6379, auth_string = "auth" }
  }
}

variables {
  name            = "boilerplate-production"
  project_id      = "example-project"
  region          = "europe-west1"
  secret_prefixes = ["boilerplate-production-", "boilerplate-preview-"]
}

run "keeps_data_private_and_encrypted" {
  command = plan
  assert {
    condition     = google_sql_database_instance.postgres.database_version == "POSTGRES_18"
    error_message = "Postgres 18"
  }
  assert {
    condition     = google_sql_database_instance.postgres.settings[0].ip_configuration[0].ipv4_enabled == false && google_sql_database_instance.postgres.settings[0].ip_configuration[0].ssl_mode == "ENCRYPTED_ONLY"
    error_message = "the database must be private and require TLS"
  }
  assert {
    condition     = google_redis_instance.valkey.auth_enabled && google_redis_instance.valkey.redis_configs["maxmemory-policy"] == "noeviction"
    error_message = "Valkey with AUTH and without eviction"
  }
  assert {
    condition     = google_sql_database_instance.postgres.deletion_protection
    error_message = "production data must survive a destroy"
  }
}

run "enforces_network_policies" {
  command = plan
  assert {
    condition     = google_container_cluster.this.datapath_provider == "ADVANCED_DATAPATH"
    error_message = "Dataplane V2 enforces the charts' NetworkPolicies"
  }
  assert {
    condition     = google_container_node_pool.default.node_config[0].workload_metadata_config[0].mode == "GKE_METADATA"
    error_message = "pods must use workload identity, not the node's credentials"
  }
}

run "lets_external_secrets_read_only_this_environment" {
  command = plan
  assert {
    condition     = google_project_iam_member.external_secrets.condition[0].expression == "resource.name.startsWith(\"projects/123456789/secrets/boilerplate-production-\") || resource.name.startsWith(\"projects/123456789/secrets/boilerplate-preview-\")"
    error_message = "secret access must be limited to the given prefixes"
  }
  assert {
    condition     = endswith(google_project_iam_member.external_secrets.member, "/subject/ns/external-secrets/sa/external-secrets")
    error_message = "access goes to External Secrets' service account"
  }
}

run "describes_itself_like_every_cloud_module" {
  command = apply
  assert {
    condition     = output.cluster_annotations == { cloud = "gcp", "secret-store" = "gcp", "gcp-project" = "example-project" }
    error_message = "cluster annotations"
  }
  assert {
    condition     = output.cluster.host == "https://34.1.2.3" && output.cluster.ca_certificate == "ca-certificate"
    error_message = "cluster output"
  }
  assert {
    condition     = output.database.host == "10.100.0.3" && output.database.tls && output.database.name == "app"
    error_message = "database output"
  }
  assert {
    condition     = output.valkey.host == "10.100.1.4" && output.valkey.password == "auth" && !output.valkey.tls
    error_message = "valkey output"
  }
}
