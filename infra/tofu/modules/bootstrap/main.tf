# Hands the cluster to GitOps: installs Argo CD, registers the cluster with the facts the
# ApplicationSets read (the GitOps bridge: labels and annotations on its Argo CD
# Secret), and creates the root Application (deploy/argocd/root.yaml). Everything else,
# add-ons included, then comes from the repository.

locals {
  annotations = merge(
    { for key, value in var.cluster_annotations : "boilerplate.dev/${key}" => value },
    {
      "boilerplate.dev/environment" = var.environment
      "boilerplate.dev/previews"    = tostring(var.previews)
    },
  )
  root = yamldecode(file("${path.module}/../../../../deploy/argocd/root.yaml"))
}

resource "helm_release" "argocd" {
  name             = "argocd"
  namespace        = "argocd"
  create_namespace = true
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = var.argocd_version
  wait             = true
  values = [yamlencode({
    configs = {
      params = {
        # The envs and previews ApplicationSets roll out data before stack.
        "applicationsetcontroller.enable.progressive.syncs" = true
      }
      cm = {
        # Sign-in through your identity provider is set up per organization (dex/OIDC).
        "admin.enabled" = true
      }
    }
    dex = { enabled = false }
  })]
}

# In-cluster registration: Argo CD deploys to the cluster it runs in, and the
# ApplicationSets select it by these labels and read its annotations.
resource "kubernetes_secret_v1" "cluster" {
  metadata {
    name      = "cluster-${var.cluster_name}"
    namespace = helm_release.argocd.namespace
    labels = merge(
      {
        "argocd.argoproj.io/secret-type" = "cluster"
        "boilerplate.dev/managed"        = "true"
        "boilerplate.dev/environment"    = var.environment
      },
      var.previews ? { "boilerplate.dev/previews" = "true" } : {},
    )
    annotations = local.annotations
  }
  data = {
    name   = var.cluster_name
    server = "https://kubernetes.default.svc"
    config = jsonencode({ tlsClientConfig = { insecure = false } })
  }
}

resource "helm_release" "root" {
  name       = "argocd-root"
  namespace  = helm_release.argocd.namespace
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argocd-apps"
  version    = var.argocd_apps_version
  values = [yamlencode({
    applications = {
      (local.root.metadata.name) = merge(local.root.spec, {
        namespace = local.root.metadata.namespace
        source    = merge(local.root.spec.source, { repoURL = var.repo_url })
      })
    }
  })]
  depends_on = [kubernetes_secret_v1.cluster]
}
