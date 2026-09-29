# Writes the environment's secrets (the app-secrets module's output, and platform ones)
# to AWS Secrets Manager, where External Secrets reads them.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
  }
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

resource "aws_secretsmanager_secret" "this" {
  for_each = toset(var.names)
  name     = each.key
  # Deleted secrets are recoverable for a week.
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "this" {
  for_each      = toset(var.names)
  secret_id     = aws_secretsmanager_secret.this[each.key].id
  secret_string = var.values[each.key]
}

output "names_written" {
  description = "The secrets written, name → ARN."
  value       = { for name, secret in aws_secretsmanager_secret.this : name => secret.arn }
}
