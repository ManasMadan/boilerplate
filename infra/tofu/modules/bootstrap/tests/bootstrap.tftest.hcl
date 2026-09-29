# Against mocked Helm and Kubernetes APIs: Argo CD, the GitOps bridge Secret and the
# root Application.

mock_provider "helm" {}
mock_provider "kubernetes" {}

variables {
  cluster_name = "aws-production"
  environment  = "production"
  cluster_annotations = {
    cloud        = "aws"
    domain       = "example.com"
    secret-store = "aws"
    aws-region   = "eu-west-1"
  }
}

run "registers_the_cluster_for_the_applicationsets" {
  command = apply
  assert {
    condition = kubernetes_secret_v1.cluster.metadata[0].labels == tomap({
      "argocd.argoproj.io/secret-type" = "cluster"
      "boilerplate.dev/managed"        = "true"
      "boilerplate.dev/environment"    = "production"
    })
    error_message = "the platform and envs ApplicationSets select clusters by these labels"
  }
  assert {
    condition     = kubernetes_secret_v1.cluster.metadata[0].annotations["boilerplate.dev/domain"] == "example.com"
    error_message = "cluster facts become boilerplate.dev/ annotations"
  }
  assert {
    condition     = kubernetes_secret_v1.cluster.metadata[0].annotations["boilerplate.dev/environment"] == "production"
    error_message = "the platform config reads the environment from an annotation"
  }
  assert {
    condition     = kubernetes_secret_v1.cluster.data.server == "https://kubernetes.default.svc"
    error_message = "Argo CD deploys to its own cluster"
  }
}

run "marks_the_cluster_that_hosts_previews" {
  command = apply
  variables {
    environment = "staging"
    previews    = true
  }
  assert {
    condition     = kubernetes_secret_v1.cluster.metadata[0].labels["boilerplate.dev/previews"] == "true"
    error_message = "the previews ApplicationSet selects clusters by this label"
  }
  assert {
    condition     = kubernetes_secret_v1.cluster.metadata[0].annotations["boilerplate.dev/previews"] == "true"
    error_message = "the platform config reads it to add the preview listener"
  }
}

run "turns_on_progressive_syncs" {
  command = apply
  assert {
    condition     = yamldecode(helm_release.argocd.values[0]).configs.params["applicationsetcontroller.enable.progressive.syncs"] == true
    error_message = "RollingSync (data before stack) needs progressive syncs"
  }
}

run "creates_the_root_application_from_the_repo" {
  command = apply
  assert {
    condition     = yamldecode(helm_release.root.values[0]).applications.root.source.path == "deploy/argocd"
    error_message = "the root app is deploy/argocd/root.yaml"
  }
  assert {
    condition     = yamldecode(helm_release.root.values[0]).applications.root.namespace == "argocd"
    error_message = "the root app lives with Argo CD"
  }
}

run "rejects_unknown_environments" {
  command = plan
  variables {
    environment = "prod"
  }
  expect_failures = [var.environment]
}
