# Writes the environment's secrets to Google Secret Manager, where External Secrets
# reads them.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.4"
    }
  }
}

variable "project_id" {
  type = string
}

variable "names" {
  description = "The secret names (not sensitive, so they can be for_each keys)."
  type        = list(string)
}

variable "values" {
  description = "Name → JSON value."
  type        = map(string)
  sensitive   = true
}

resource "google_secret_manager_secret" "this" {
  for_each  = toset(var.names)
  project   = var.project_id
  secret_id = each.key
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "this" {
  for_each    = toset(var.names)
  secret      = google_secret_manager_secret.this[each.key].id
  secret_data = var.values[each.key]
}

output "names_written" {
  description = "The secrets written, name → id."
  value       = { for name, secret in google_secret_manager_secret.this : name => secret.id }
}
