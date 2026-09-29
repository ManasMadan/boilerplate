terraform {
  required_version = ">= 1.11.0"

  # Remote state per environment: `tofu init -backend-config=backend-<env>.hcl`.
  backend "s3" {}

  # State and plans hold every generated secret, so they're encrypted with a KMS key
  # before they leave this machine; unencrypted state is refused.
  encryption {
    key_provider "aws_kms" "state" {
      kms_key_id = var.state_kms_key_id
      region     = var.region
      key_spec   = "AES_256"
    }
    method "aes_gcm" "state" {
      keys = key_provider.aws_kms.state
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
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
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
