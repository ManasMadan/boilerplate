# Every secret the charts read, as the JSON objects External Secrets extracts
# (deploy/README.md lists the contract): one per database role, the admin login, Valkey,
# and one per service with its generated secrets, storage credentials and any provider
# keys passed in. Generated values are created once and kept in state.

locals {
  roles        = ["migrator", "app_api", "app_worker", "app_notifications", "app_webhooks", "app_ai"]
  data_roles   = var.include_data ? local.roles : []
  python_roles = ["app_ai"]

  db = var.include_data ? var.database : { host = "", port = 0, name = "", admin_username = "", admin_password = "", tls = false }
  # Node services use node-postgres, which only encrypts without verifying the
  # server's certificate (libpq's `require`) in libpq compatibility mode; Python and psql
  # are libpq already.
  node_ssl   = local.db.tls ? "?sslmode=require&uselibpqcompat=true" : ""
  libpq_ssl  = local.db.tls ? "?sslmode=require" : ""
  role_url   = { for role in local.data_roles : role => "postgresql://${role}:${random_password.role[role].result}@${local.db.host}:${local.db.port}/${local.db.name}${contains(local.python_roles, role) ? local.libpq_ssl : local.node_ssl}" }
  valkey_url = var.include_data ? "${var.valkey.tls ? "rediss" : "redis"}://:${var.valkey.password}@${var.valkey.host}:${var.valkey.port}" : ""

  storage = {
    S3_BUCKET            = var.storage.bucket
    S3_REGION            = var.storage.region
    S3_ENDPOINT          = var.storage.endpoint
    S3_ACCESS_KEY_ID     = var.storage.access_key_id
    S3_SECRET_ACCESS_KEY = var.storage.secret_access_key
  }
  turnstile = var.turnstile == null ? {} : {
    TURNSTILE_SITE_KEY   = var.turnstile.site_key
    TURNSTILE_SECRET_KEY = var.turnstile.secret_key
  }
  encryption_keys = "k1:${random_bytes.encryption_key.base64}"

  services = {
    web = { STORAGE_ORIGIN = var.storage.public_origin }
    api = merge(local.storage, local.turnstile, {
      BETTER_AUTH_SECRET = random_password.auth_secret.result
      ENCRYPTION_KEYS    = local.encryption_keys
      UNSUBSCRIBE_SECRET = random_password.unsubscribe_secret.result
      AI_SERVICE_SECRET  = random_password.ai_service_secret.result
    })
    worker        = local.storage
    notifications = { UNSUBSCRIBE_SECRET = random_password.unsubscribe_secret.result }
    webhooks      = { ENCRYPTION_KEYS = local.encryption_keys }
    ai            = { AI_SERVICE_SECRET = random_password.ai_service_secret.result }
  }
}

resource "random_password" "role" {
  for_each = toset(local.data_roles)
  length   = 40
  # Letters and digits only: they go into connection URLs unescaped.
  special = false
}

resource "random_password" "auth_secret" {
  length  = 48
  special = false
}

resource "random_password" "unsubscribe_secret" {
  length  = 48
  special = false
}

resource "random_password" "ai_service_secret" {
  length  = 48
  special = false
}

# AES-256 key for data encrypted at rest (webhook signing secrets, …); rotate by
# prepending a new id:key to ENCRYPTION_KEYS.
resource "random_bytes" "encryption_key" {
  length = 32
}
