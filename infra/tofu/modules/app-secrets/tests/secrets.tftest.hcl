# The secrets the charts read: names, shapes and the connection URLs each runtime needs.

variables {
  key_prefix = "boilerplate-production-"
  database = {
    host           = "db.internal"
    port           = 5432
    name           = "app"
    admin_username = "admin"
    admin_password = "adminpw"
    tls            = true
  }
  valkey = {
    host     = "cache.internal"
    port     = 6380
    password = "cachepw"
    tls      = true
  }
  storage = {
    endpoint          = "https://acct.r2.cloudflarestorage.com"
    region            = "auto"
    bucket            = "uploads"
    access_key_id     = "key"
    secret_access_key = "secret"
    public_origin     = "https://acct.r2.cloudflarestorage.com"
  }
  service_secrets = {
    api = { STRIPE_SECRET_KEY = "sk_test_x" }
  }
}

run "names_every_secret_the_charts_read" {
  command = apply
  assert {
    condition = toset(output.secret_names) == toset([
      "boilerplate-production-migrator", "boilerplate-production-app-api",
      "boilerplate-production-app-worker", "boilerplate-production-app-notifications",
      "boilerplate-production-app-webhooks", "boilerplate-production-app-ai",
      "boilerplate-production-admin", "boilerplate-production-valkey",
      "boilerplate-production-web", "boilerplate-production-api",
      "boilerplate-production-worker", "boilerplate-production-notifications",
      "boilerplate-production-webhooks", "boilerplate-production-ai",
    ])
    error_message = "unexpected secret names"
  }
  assert {
    condition     = toset(keys(output.secrets)) == toset(output.secret_names)
    error_message = "secret_names must list exactly the secrets"
  }
}

run "gives_each_role_its_own_password_and_url" {
  command = apply
  assert {
    condition     = jsondecode(output.secrets["boilerplate-production-app-api"]).username == "app_api"
    error_message = "role secret must name its role"
  }
  assert {
    condition     = jsondecode(output.secrets["boilerplate-production-app-api"]).password != jsondecode(output.secrets["boilerplate-production-app-worker"]).password
    error_message = "roles must not share a password"
  }
  assert {
    condition     = can(regex("^[A-Za-z0-9]{40}$", jsondecode(output.secrets["boilerplate-production-migrator"]).password))
    error_message = "passwords must be URL-safe"
  }
  assert {
    condition     = can(regex("^postgresql://app_api:[A-Za-z0-9]{40}@db.internal:5432/app\\?sslmode=require&uselibpqcompat=true$", jsondecode(output.secrets["boilerplate-production-app-api"]).url))
    error_message = "Node services need libpq-compatible TLS in their URL"
  }
  assert {
    condition     = endswith(jsondecode(output.secrets["boilerplate-production-app-ai"]).url, "/app?sslmode=require")
    error_message = "the Python service's URL must be plain libpq"
  }
  assert {
    condition     = jsondecode(output.secrets["boilerplate-production-admin"]).url == "postgresql://admin:adminpw@db.internal:5432/app?sslmode=require"
    error_message = "the admin URL is for psql (libpq)"
  }
}

run "connects_to_valkey_over_tls" {
  command = apply
  assert {
    condition     = jsondecode(output.secrets["boilerplate-production-valkey"]).url == "rediss://:cachepw@cache.internal:6380"
    error_message = "a TLS Valkey needs rediss://"
  }
  assert {
    condition     = jsondecode(output.secrets["boilerplate-production-valkey"]).port == "6380"
    error_message = "the port must be a string (Secret data)"
  }
}

run "shares_generated_secrets_between_the_services_that_need_them" {
  command = apply
  assert {
    condition     = jsondecode(output.secrets["boilerplate-production-api"]).ENCRYPTION_KEYS == jsondecode(output.secrets["boilerplate-production-webhooks"]).ENCRYPTION_KEYS
    error_message = "api and webhooks must encrypt with the same keys"
  }
  assert {
    condition     = jsondecode(output.secrets["boilerplate-production-api"]).AI_SERVICE_SECRET == jsondecode(output.secrets["boilerplate-production-ai"]).AI_SERVICE_SECRET
    error_message = "api and ai must share the service secret"
  }
  assert {
    condition     = can(regex("^k1:[A-Za-z0-9+/]{43}=$", jsondecode(output.secrets["boilerplate-production-api"]).ENCRYPTION_KEYS))
    error_message = "ENCRYPTION_KEYS must be id:base64(32 bytes)"
  }
  assert {
    condition     = jsondecode(output.secrets["boilerplate-production-api"]).STRIPE_SECRET_KEY == "sk_test_x"
    error_message = "provider keys passed in must reach their service"
  }
  assert {
    condition     = jsondecode(output.secrets["boilerplate-production-worker"]).S3_BUCKET == "uploads"
    error_message = "the worker needs storage credentials"
  }
  assert {
    condition     = !can(jsondecode(output.secrets["boilerplate-production-api"]).TURNSTILE_SITE_KEY)
    error_message = "no captcha keys unless Turnstile is set up"
  }
}

run "uses_plain_connections_without_tls" {
  command = apply
  variables {
    database = {
      host           = "db"
      port           = 5432
      name           = "app"
      admin_username = "admin"
      admin_password = "pw"
      tls            = false
    }
    valkey = {
      host     = "cache"
      port     = 6379
      password = "pw"
      tls      = false
    }
  }
  assert {
    condition     = endswith(jsondecode(output.secrets["boilerplate-production-app-api"]).url, "@db:5432/app")
    error_message = "no TLS options without TLS"
  }
  assert {
    condition     = startswith(jsondecode(output.secrets["boilerplate-production-valkey"]).url, "redis://")
    error_message = "plain Valkey is redis://"
  }
}

run "rejects_prefixes_secret_managers_refuse" {
  command = plan
  variables {
    key_prefix = "boilerplate/production/"
  }
  expect_failures = [var.key_prefix]
}

run "leaves_data_secrets_to_previews_themselves" {
  command = apply
  variables {
    key_prefix   = "boilerplate-preview-"
    include_data = false
    database     = null
    valkey       = null
  }
  assert {
    condition = toset(output.secret_names) == toset([
      "boilerplate-preview-web", "boilerplate-preview-api", "boilerplate-preview-worker",
      "boilerplate-preview-notifications", "boilerplate-preview-webhooks", "boilerplate-preview-ai",
    ])
    error_message = "previews only need the services' secrets"
  }
  assert {
    condition     = toset(keys(output.secrets)) == toset(output.secret_names)
    error_message = "secret_names must list exactly the secrets"
  }
}
