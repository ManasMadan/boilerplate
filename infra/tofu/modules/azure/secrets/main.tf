# Writes the environment's secrets to its Key Vault, where External Secrets reads them.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
  }
}

variable "key_vault_id" {
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

resource "azurerm_key_vault_secret" "this" {
  for_each     = toset(var.names)
  key_vault_id = var.key_vault_id
  name         = each.key
  value        = var.values[each.key]
  content_type = "application/json"
}

output "names_written" {
  description = "The secrets written, name → id."
  value       = { for name, secret in azurerm_key_vault_secret.this : name => secret.id }
}
