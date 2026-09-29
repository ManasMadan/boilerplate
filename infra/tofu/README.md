# Infrastructure (OpenTofu)

One root per cloud in `envs/`, one state per environment. Each creates everything an
environment needs and hands the cluster to Argo CD, which deploys the rest from this
repository (see `deploy/README.md`).

```
modules/
  aws, gcp, azure   network, Kubernetes (standard node pools), managed Postgres 18 and
                    Valkey/Redis; the same outputs on every cloud
  <cloud>/secrets   writes secrets to that cloud's secret manager
  cloudflare        zone TLS settings, optional WAF, the R2 uploads bucket, scoped API
                    tokens (DNS, storage) and the Turnstile widget
  app-secrets       every secret the charts read, generated once (passwords, keys) or
                    built from the other modules' outputs (URLs, storage credentials)
  bootstrap         Argo CD, the cluster's registration (labels and annotations the
                    ApplicationSets read) and the root Application
envs/aws, envs/gcp, envs/azure
```

`bun run infra:check` runs `tofu fmt`, `validate` and every module's and root's tests.
The tests run against mocked cloud APIs, so they create nothing and need no
credentials.

## Setting up an environment

Once per cloud account, outside these roots: a state bucket (or storage account) and a
key to encrypt state with (KMS on AWS and GCP; a passphrase on Azure). Then:

```sh
cd infra/tofu/envs/aws                        # or gcp, azure
cp backend-staging.hcl.example backend-staging.hcl
cp staging.tfvars.example staging.tfvars      # fill in your values
export CLOUDFLARE_API_TOKEN=…                 # see modules/cloudflare for its permissions
tofu init -backend-config=backend-staging.hcl
tofu apply -var-file=staging.tfvars
```

Provider keys (Stripe, Resend, Twilio, Google sign-in, …) go in `service_secrets`,
per service; everything else is generated. Set `previews = true` on the environment
whose cluster should also run pull-request previews (normally staging), with
`TF_VAR_github_token` for Argo CD to list pull requests.

Afterwards, point `site.host` in `deploy/environments/<env>/stack.yaml` at the same host
as `site_host`, and Argo CD takes it from there.

## Where the clouds differ

- **Cluster access**: `aws eks get-token`, gcloud's access token, and Entra ID through
  kubelogin on Azure (no static admin credentials on any of them).
- **Secret access**: External Secrets may read only the environment's own prefix on AWS
  and GCP; on Azure each environment has its own Key Vault, which it may read.
- **Redis on GCP** runs without TLS (AUTH only, on a private address): Memorystore's
  certificates come from a private Google CA that the services' Redis clients don't
  trust yet. AWS and Azure use TLS with publicly trusted certificates.
- **Load balancing on AWS** needs the AWS Load Balancer Controller, which the aws
  module installs; GKE and AKS provision load balancers themselves.
