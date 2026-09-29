variable "name" {
  description = "Name for this environment's resources, e.g. boilerplate-production."
  type        = string
}

variable "region" {
  type = string
}

variable "secret_prefixes" {
  description = "Prefixes of the secrets External Secrets may read in Secrets Manager: this environment's, plus boilerplate-preview- on the cluster hosting previews."
  type        = list(string)
}

variable "kubernetes_version" {
  type    = string
  default = "1.34"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "single_nat_gateway" {
  description = "One NAT gateway for the VPC (cheaper) instead of one per zone (survives a zone outage)."
  type        = bool
  default     = true
}

variable "api_allowed_cidrs" {
  description = "Who may reach the Kubernetes API from the internet."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "nodes" {
  # null (from an environment that sets nothing) means the default.
  nullable    = false
  description = "The managed node group (Graviton by default: the images are built for arm64 too)."
  type = object({
    instance_types = list(string)
    # AL2023_ARM_64_STANDARD for Graviton, AL2023_x86_64_STANDARD for Intel/AMD.
    ami_type     = string
    min_size     = number
    max_size     = number
    desired_size = number
  })
  default = {
    instance_types = ["m7g.large"]
    ami_type       = "AL2023_ARM_64_STANDARD"
    min_size       = 2
    max_size       = 6
    desired_size   = 3
  }
}

variable "database" {
  # null (from an environment that sets nothing) means the default.
  nullable = false
  type = object({
    instance_class        = string
    allocated_storage     = number
    max_allocated_storage = number
    multi_az              = bool
    deletion_protection   = bool
    backup_retention_days = number
  })
  default = {
    instance_class        = "db.t4g.medium"
    allocated_storage     = 20
    max_allocated_storage = 200
    multi_az              = false
    deletion_protection   = true
    backup_retention_days = 7
  }
}

variable "valkey" {
  # null (from an environment that sets nothing) means the default.
  nullable = false
  type = object({
    node_type = string
    # Replicas besides the primary (automatic failover with at least one).
    replicas = number
  })
  default = {
    node_type = "cache.t4g.small"
    replicas  = 1
  }
}
