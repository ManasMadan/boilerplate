# The whole environment wired together, against mocked providers. Installing over SSH
# only happens on apply, so these runs render cloud-init instead: the same k3s
# configuration, without reaching for machines.

mock_provider "cloudflare" {
  override_data {
    target = module.cloudflare.data.cloudflare_zone.this
    values = { zone_id = "023e105f4ecef8ad9ca31a8372d0c353" }
  }
  override_data {
    target = module.cloudflare.data.cloudflare_api_token_permission_groups_list.this
    values = { result = [{ id = "perm-id", name = "permission", scopes = [] }] }
  }
  mock_resource "cloudflare_api_token" {
    defaults = { id = "token-id", value = "token-value" }
  }
  mock_resource "cloudflare_turnstile_widget" {
    defaults = { sitekey = "site-key", secret = "secret-key" }
  }
}
mock_provider "helm" {}
mock_provider "kubernetes" {}
mock_provider "random" {}
mock_provider "tls" {
  mock_resource "tls_self_signed_cert" {
    defaults = { cert_pem = "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n" }
  }
}

variables {
  environment           = "staging"
  domain                = "example.com"
  site_host             = "staging.example.com"
  cloudflare_account_id = "01a7362d577a6c3019a474fd6f485823"
  tls_email             = "ops@example.com"
  previews              = true
  install_over_ssh      = false
  sops_age_key          = "AGE-SECRET-KEY-1QQQQ"
  sops_preview_age_key  = "AGE-SECRET-KEY-1PPPP"
  state_passphrase      = "correct horse battery staple"
  nodes = {
    staging-1 = { address = "203.0.113.10" }
  }
}

run "one_node_staging" {
  command = apply
  assert {
    condition = module.bootstrap.cluster_labels == tomap({
      "argocd.argoproj.io/secret-type" = "cluster"
      "boilerplate.dev/managed"        = "true"
      "boilerplate.dev/environment"    = "staging"
      "boilerplate.dev/previews"       = "true"
    })
    error_message = "staging hosts previews, without the observability add-ons"
  }
  assert {
    condition     = module.bootstrap.cluster_annotations["boilerplate.dev/image-policy"] == "false" && module.bootstrap.cluster_annotations["boilerplate.dev/domain"] == "example.com" && module.bootstrap.cluster_annotations["boilerplate.dev/dns01"] == "cloudflare"
    error_message = "staging admits unsigned images; the platform config gets the domain and DNS-01 provider"
  }
  assert {
    condition     = !contains(keys(module.bootstrap.cluster_annotations), "boilerplate.dev/mail-host") && !contains(keys(module.bootstrap.cluster_annotations), "boilerplate.dev/mail-domain")
    error_message = "no mail host or domain until mail is set up"
  }
  assert {
    condition = toset([for record in output.dns_records : "${record.name} ${record.type} ${record.content} ${record.proxied}"]) == toset([
      "staging.example.com A 203.0.113.10 true",
      "*.preview.example.com A 203.0.113.10 false",
    ])
    error_message = "the site (proxied) and previews on the node"
  }
  assert {
    condition     = output.api_url == "https://203.0.113.10:6443"
    error_message = "the API on the only server"
  }
}

run "production_with_ha_and_mail" {
  command = apply
  variables {
    environment   = "production"
    site_host     = "app.example.com"
    previews      = false
    observability = true
    nodes = {
      server-1 = { address = "203.0.113.10", private_address = "10.0.0.10" }
      server-2 = { address = "203.0.113.11", private_address = "10.0.0.11" }
      server-3 = { address = "203.0.113.12", private_address = "10.0.0.12" }
      agent-1  = { address = "203.0.113.20", private_address = "10.0.0.20", role = "agent" }
    }
    mail = {
      node               = "agent-1"
      domain             = "example.com"
      dkim_public_key    = "MCowBQYDK2VwAyEA"
      dmarc_report_email = "dmarc@example.com"
    }
  }
  assert {
    condition     = module.bootstrap.cluster_labels["boilerplate.dev/observability"] == "true" && !contains(keys(module.bootstrap.cluster_labels), "boilerplate.dev/previews")
    error_message = "production opts into observability and hosts no previews"
  }
  assert {
    condition     = module.bootstrap.cluster_annotations["boilerplate.dev/image-policy"] == "true" && module.bootstrap.cluster_annotations["boilerplate.dev/mail-host"] == "mail.example.com" && module.bootstrap.cluster_annotations["boilerplate.dev/mail-domain"] == "example.com"
    error_message = "production only runs signed images; the mail server learns its host name and email domain"
  }
  assert {
    condition     = length([for record in output.dns_records : record if record.name == "app.example.com" && record.proxied]) == 4
    error_message = "the site on every node"
  }
  assert {
    condition = toset([for record in output.dns_records : "${record.name} ${record.type} ${record.content}" if record.name != "app.example.com"]) == toset([
      "mail.example.com A 203.0.113.20",
      "example.com MX mail.example.com",
      "example.com TXT \"v=spf1 ip4:203.0.113.20 -all\"",
      "default._domainkey.example.com TXT \"v=DKIM1; k=rsa; p=MCowBQYDK2VwAyEA\"",
      "_dmarc.example.com TXT \"v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; adkim=s; aspf=s\"",
    ])
    error_message = "the mail records point at the mail node"
  }
  assert {
    condition     = yamldecode(base64decode(regex("put /etc/rancher/k3s/config.yaml '([^']+)'", base64decode(yamldecode(output.cloud_init["agent-1"]).write_files[0].content))[0]))["node-label"] == ["boilerplate.dev/mail=true"]
    error_message = "the mail node is labelled for the mail server to run on"
  }
  assert {
    condition     = yamldecode(base64decode(regex("put /etc/rancher/k3s/config.yaml '([^']+)'", base64decode(yamldecode(output.cloud_init["server-1"]).write_files[0].content))[0]))["cluster-init"]
    error_message = "three servers run embedded etcd"
  }
}

run "sends_the_site_to_chosen_origins" {
  command = apply
  variables {
    origin_ips = ["198.51.100.1"]
  }
  assert {
    condition     = [for record in output.dns_records : record.content if record.name == "staging.example.com"] == ["198.51.100.1"]
    error_message = "origin_ips replace the node addresses"
  }
}

run "mail_needs_one_of_the_nodes" {
  command = plan
  variables {
    mail = {
      node               = "mail-1"
      dkim_public_key    = "MCowBQYDK2VwAyEA"
      dmarc_report_email = "dmarc@example.com"
    }
  }
  expect_failures = [var.mail]
}
