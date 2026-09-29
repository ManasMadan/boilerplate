output "cluster_name" {
  value = module.cloud.cluster.name
}

output "kubeconfig_command" {
  value = "az aks get-credentials --resource-group ${local.name} --name ${module.cloud.cluster.name} && kubelogin convert-kubeconfig -l azurecli"
}
