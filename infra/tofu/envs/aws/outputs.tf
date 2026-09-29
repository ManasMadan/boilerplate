output "cluster_name" {
  value = module.cloud.cluster.name
}

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --region ${var.region} --name ${module.cloud.cluster.name}"
}
