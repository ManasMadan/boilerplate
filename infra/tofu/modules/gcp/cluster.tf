data "google_project" "this" {
  project_id = var.project_id
}

resource "google_container_cluster" "this" {
  project  = var.project_id
  name     = var.name
  location = var.region

  network    = google_compute_network.this.id
  subnetwork = google_compute_subnetwork.nodes.id

  # Node pools are managed below.
  remove_default_node_pool = true
  initial_node_count       = 1

  networking_mode = "VPC_NATIVE"
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }
  # Dataplane V2 enforces NetworkPolicies (the charts rely on them).
  datapath_provider = "ADVANCED_DATAPATH"

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
  }
  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.api_allowed_cidrs
      content {
        cidr_block = cidr_blocks.value
      }
    }
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }
  release_channel {
    channel = "REGULAR"
  }
  deletion_protection = var.database.deletion_protection
}

resource "google_container_node_pool" "default" {
  project  = var.project_id
  name     = "default"
  cluster  = google_container_cluster.this.id
  location = var.region

  autoscaling {
    min_node_count = var.nodes.min_count
    max_node_count = var.nodes.max_count
  }
  management {
    auto_repair  = true
    auto_upgrade = true
  }
  node_config {
    machine_type = var.nodes.machine_type
    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    workload_metadata_config {
      mode = "GKE_METADATA"
    }
    shielded_instance_config {
      enable_secure_boot = true
    }
  }
}

# External Secrets reads this environment's secrets (and the platform's) through GKE
# workload identity, as its own Kubernetes service account: no Google service account.
resource "google_project_iam_member" "external_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "principal://iam.googleapis.com/projects/${data.google_project.this.number}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/subject/ns/external-secrets/sa/external-secrets"
  condition {
    title      = "${var.name}-secrets"
    expression = join(" || ", [for prefix in var.secret_prefixes : "resource.name.startsWith(\"projects/${data.google_project.this.number}/secrets/${prefix}\")"])
  }
}

# Connection details for the outputs, read back once the cluster exists.
data "google_container_cluster" "this" {
  project  = var.project_id
  name     = google_container_cluster.this.name
  location = google_container_cluster.this.location
}
