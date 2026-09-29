variable "name" {
  description = "Name for this environment's resources, e.g. boilerplate-production."
  type        = string
}

variable "location" {
  type = string
}

variable "vnet_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "api_allowed_cidrs" {
  description = "Who may reach the Kubernetes API (empty: anyone)."
  type        = list(string)
  default     = []
}

variable "nodes" {
  # null (from an environment that sets nothing) means the default.
  nullable = false
  type = object({
    vm_size   = string
    min_count = number
    max_count = number
  })
  default = {
    vm_size   = "Standard_D4s_v5"
    min_count = 2
    max_count = 6
  }
}

variable "database" {
  # null (from an environment that sets nothing) means the default.
  nullable = false
  type = object({
    sku_name              = string
    storage_mb            = number
    zone_redundant        = bool
    backup_retention_days = number
  })
  default = {
    sku_name              = "GP_Standard_D2ds_v5"
    storage_mb            = 32768
    zone_redundant        = false
    backup_retention_days = 7
  }
}

variable "valkey" {
  # null (from an environment that sets nothing) means the default.
  nullable = false
  type = object({
    sku_name          = string
    high_availability = bool
  })
  default = {
    sku_name          = "Balanced_B0"
    high_availability = true
  }
}
