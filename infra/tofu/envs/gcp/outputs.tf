output "cluster_name" {
  value = module.cloud.cluster.name
}

output "kubeconfig_command" {
  value = "gcloud container clusters get-credentials ${module.cloud.cluster.name} --region ${var.region} --project ${var.project_id}"
}
