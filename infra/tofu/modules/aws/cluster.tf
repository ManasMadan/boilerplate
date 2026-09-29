module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.26"

  name               = var.name
  kubernetes_version = var.kubernetes_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  endpoint_public_access       = true
  endpoint_public_access_cidrs = var.api_allowed_cidrs

  # Whoever runs `tofu apply` administers the cluster (to bootstrap Argo CD).
  enable_cluster_creator_admin_permissions = true

  addons = {
    coredns                = {}
    kube-proxy             = {}
    eks-pod-identity-agent = { before_compute = true }
    vpc-cni                = { before_compute = true }
    aws-ebs-csi-driver = {
      pod_identity_association = [{
        role_arn        = module.ebs_csi_identity.iam_role_arn
        service_account = "ebs-csi-controller-sa"
      }]
    }
  }

  eks_managed_node_groups = {
    default = {
      ami_type       = var.nodes.ami_type
      instance_types = var.nodes.instance_types
      min_size       = var.nodes.min_size
      max_size       = var.nodes.max_size
      desired_size   = var.nodes.desired_size
    }
  }
}

data "aws_caller_identity" "current" {}

# Workload identities (EKS Pod Identity): each add-on gets only the AWS access it needs.
# Fixed role names: IAM caps generated name prefixes at 38 characters.
module "external_secrets_identity" {
  source  = "terraform-aws-modules/eks-pod-identity/aws"
  version = "~> 2.9"

  name                           = "${var.name}-external-secrets"
  use_name_prefix                = false
  attach_external_secrets_policy = true
  external_secrets_secrets_manager_arns = [
    for prefix in var.secret_prefixes : "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:${prefix}*"
  ]
  associations = {
    this = {
      cluster_name    = module.eks.cluster_name
      namespace       = "external-secrets"
      service_account = "external-secrets"
    }
  }
}

module "load_balancer_controller_identity" {
  source  = "terraform-aws-modules/eks-pod-identity/aws"
  version = "~> 2.9"

  name                            = "${var.name}-aws-lb-controller"
  use_name_prefix                 = false
  attach_aws_lb_controller_policy = true
  associations = {
    this = {
      cluster_name    = module.eks.cluster_name
      namespace       = "kube-system"
      service_account = "aws-load-balancer-controller"
    }
  }
}

module "ebs_csi_identity" {
  source  = "terraform-aws-modules/eks-pod-identity/aws"
  version = "~> 2.9"

  name                      = "${var.name}-ebs-csi"
  use_name_prefix           = false
  attach_aws_ebs_csi_policy = true
}

# The gateway's Service asks for an NLB (deploy/platform/config/values-aws.yaml); this
# controller provisions it. AWS-specific, so it's installed here rather than by Argo CD.
resource "helm_release" "load_balancer_controller" {
  name       = "aws-load-balancer-controller"
  namespace  = "kube-system"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = "3.5.0"
  values = [yamlencode({
    clusterName    = module.eks.cluster_name
    region         = var.region
    vpcId          = module.vpc.vpc_id
    serviceAccount = { name = "aws-load-balancer-controller" }
  })]
  depends_on = [module.load_balancer_controller_identity]
}
