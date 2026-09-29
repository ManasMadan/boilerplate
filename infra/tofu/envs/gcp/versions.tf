terraform {
  required_version = ">= 1.11.0"

  # Remote state per environment: `tofu init -backend-config=backend-<env>.hcl`.
  backend "gcs" {}

  # State and plans hold every generated secret, so they're encrypted with a Cloud KMS
  # key before they leave this machine; unencrypted state is refused.
  encryption {
    key_provider "gcp_kms" "state" {
      kms_encryption_key = var.state_kms_key
      key_length         = 32
    }
    method "aes_gcm" "state" {
      keys = key_provider.gcp_kms.state
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
    google = {
      source  = "hashicorp/google"
      version = "~> 8.4"
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
