output "secrets" {
  description = "Remote secret name → JSON value, for the cloud's secret manager."
  sensitive   = true
  value = merge(
    {
      for role in local.data_roles : "${var.key_prefix}${replace(role, "_", "-")}" => jsonencode({
        username  = role
        password  = random_password.role[role].result
        url       = local.role_url[role]
        directUrl = local.role_url[role]
      })
    },
    var.include_data ? {
      "${var.key_prefix}admin" = jsonencode({
        url = "postgresql://${local.db.admin_username}:${local.db.admin_password}@${local.db.host}:${local.db.port}/${local.db.name}${local.libpq_ssl}"
      })
      "${var.key_prefix}valkey" = jsonencode({
        host     = var.valkey.host
        port     = tostring(var.valkey.port)
        password = var.valkey.password
        url      = local.valkey_url
      })
    } : {},
    {
      for service, generated in local.services : "${var.key_prefix}${service}" => jsonencode(
        merge(generated, lookup(var.service_secrets, service, {}))
      )
    },
  )
}

output "secret_names" {
  description = "The remote secret names (not sensitive), for the cloud module's for_each."
  value = concat(
    [for role in local.data_roles : "${var.key_prefix}${replace(role, "_", "-")}"],
    var.include_data ? ["${var.key_prefix}admin", "${var.key_prefix}valkey"] : [],
    [for service in keys(local.services) : "${var.key_prefix}${service}"],
  )
}
