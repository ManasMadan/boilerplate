output "argocd_namespace" {
  value = helm_release.argocd.namespace
}

output "cluster_annotations" {
  description = "What the ApplicationSets see on this cluster."
  value       = kubernetes_secret_v1.cluster.metadata[0].annotations
}
