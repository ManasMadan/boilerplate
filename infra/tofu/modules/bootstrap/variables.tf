variable "cluster_name" {
  description = "The cluster's name in Argo CD (e.g. aws-production)."
  type        = string
}

variable "environment" {
  description = "What the cluster runs: staging or production."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "staging or production."
  }
}

variable "previews" {
  description = "Run pull-request previews on this cluster too (normally staging's)."
  type        = bool
  default     = false
}

variable "cluster_annotations" {
  description = "Facts about the cluster for the platform ApplicationSet (boilerplate.dev/<key>): the cloud module's cluster_annotations plus domain, TLS email and the like."
  type        = map(string)
}

variable "repo_url" {
  description = "The Git repository Argo CD deploys from."
  type        = string
  default     = "https://github.com/ManasMadan/boilerplate.git"
}

variable "argocd_version" {
  description = "The argo-cd Helm chart version."
  type        = string
  default     = "10.9.2"
}

variable "argocd_apps_version" {
  description = "The argocd-apps Helm chart version (creates the root Application)."
  type        = string
  default     = "2.0.5"
}
