output "api_url" {
  value = module.k3s.api_url
}

output "kubeconfig" {
  description = "tofu output -raw kubeconfig > ~/.kube/boilerplate-<env>"
  sensitive   = true
  value       = module.k3s.kubeconfig
}

output "cloud_init" {
  description = "User data per node, with install_over_ssh = false."
  sensitive   = true
  value       = module.k3s.cloud_init
}

output "dns_records" {
  value = module.cloudflare.records
}

output "cloudflare_dns_api_token" {
  description = "For cert-manager's DNS-01 challenges: encrypt it into the platform's SOPS secrets."
  sensitive   = true
  value       = module.cloudflare.dns_api_token
}

output "turnstile" {
  description = "The captcha's site key and secret, for the api's SOPS secrets."
  sensitive   = true
  value       = module.cloudflare.turnstile
}
