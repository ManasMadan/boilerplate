variable "name" {
  description = "Name for this environment's resources, e.g. boilerplate-production."
  type        = string
}

variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "secret_prefixes" {
  description = "Prefixes of the secrets External Secrets may read in Secret Manager: this environment's, plus boilerplate-preview- on the cluster hosting previews."
  type        = list(string)
}

variable "network_cidr" {
  description = "Nodes' range; pods and services get their own secondary ranges."
  type        = string
  default     = "10.0.0.0/20"
}

variable "api_allowed_cidrs" {
  description = "Who may reach the Kubernetes API."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "nodes" {
  # null (from an environment that sets nothing) means the default.
  nullable = false
  type = object({
    machine_type = string
    min_count    = number
    max_count    = number
  })
  default = {
    machine_type = "e2-standard-4"
    min_count    = 1
    max_count    = 3
  }
}

variable "database" {
  # null (from an environment that sets nothing) means the default.
  nullable = false
  type = object({
    tier                = string
    disk_size_gb        = number
    high_availability   = bool
    deletion_protection = bool
  })
  default = {
    tier                = "db-custom-2-7680"
    disk_size_gb        = 20
    high_availability   = false
    deletion_protection = true
  }
}

variable "valkey" {
  # null (from an environment that sets nothing) means the default.
  nullable = false
  type = object({
    memory_size_gb    = number
    high_availability = bool
  })
  default = {
    memory_size_gb    = 1
    high_availability = true
  }
}
