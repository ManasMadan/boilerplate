terraform {
  required_version = ">= 1.11.0"

  # Remote state per environment: `tofu init -backend-config=backend-<env>.hcl`.
  backend "azurerm" {}

  # State and plans hold every generated secret, so they're encrypted before they leave
  # this machine (a passphrase: OpenTofu has no Key Vault key provider); unencrypted
  # state is refused. Keep the passphrase in your secret store and pass it as
  # TF_VAR_state_passphrase.
  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.38"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}
