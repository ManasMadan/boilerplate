# Deploying

Everything here runs on any conformant Kubernetes cluster (EKS, GKE, AKS, kind, your
own). Cloud differences live in `infra/tofu` and in each environment's values, never in
the charts.

```
deploy/
  docker/          one Dockerfile per kind of image (docker-bake.hcl builds them all)
  charts/stack     the application: every service from one values file
  charts/data      Postgres (CloudNativePG or a managed database), Valkey, their Secrets
  environments/    values per environment: local (kind), preview, staging, production
  platform/        cluster add-ons (addons/, values/) and each cluster's own settings (config/)
  argocd/          the root Application, projects and ApplicationSets (GitOps)
```

`bun run charts:check` lints both charts, runs their unit tests, renders them for every
environment and validates the result against Kubernetes and the CRDs they use.

## Two releases per environment

`data` and `stack` are separate releases in the same namespace, `data` first. The
stack's migration Job runs before its services (a Helm pre-install/pre-upgrade hook,
an Argo CD PreSync hook), so the database must already be up. Keeping it in its own
release is what guarantees that, and it means redeploying the application never touches
the database.

## What each environment provides

The charts read everything environment-specific from Secrets, so the same manifests
run everywhere.

| Secret | Keys | Written by |
|---|---|---|
| `db-<role>` for `migrator`, `app_api`, `app_worker`, `app_notifications`, `app_webhooks`, `app_ai` | `username`, `password`, `url`, `directUrl` | the data chart: generated (in-cluster Postgres), extracted from the secret manager (managed Postgres, written there by OpenTofu), or created by `bun run k8s:up` on kind |
| `valkey` | `host`, `port`, `password`, `url` | the same |
| `<release>-<service>` for `web`, `api`, `worker`, `notifications`, `webhooks`, `ai` | any of the service's variables (see each app's `src/env.ts`, or `app/settings.py` for ai) | External Secrets, from the secret manager key `<keyPrefix><service>`: one JSON object, e.g. `{"BETTER_AUTH_SECRET": "…", "S3_BUCKET": "…"}` |

Plain settings shared by every environment (URLs between services, the site's origin,
ports) are in the stack chart's values; per-environment ones go in
`environments/<env>/stack.yaml` or, when they're secret, in the secret manager.

The site's hosts (`site.host`) in `environments/staging` and `environments/production`
are placeholders: set yours.

## GitOps

OpenTofu installs Argo CD on each cluster and applies `argocd/root.yaml`; from then on
everything comes from this repo. Three ApplicationSets do the work:

- **platform**: every add-on in `platform/addons` on every managed cluster, plus
  `platform/config` (the public Gateway and its certificates, the secret store, the
  image policy).
- **envs**: the data and stack releases on the staging and production clusters, data
  first. A merge to master deploys staging (CI commits the new image tag); production
  changes only through a promotion pull request.
- **previews**: a preview per pull request labelled `preview`, in its own namespace,
  at `https://pr-<number>.preview.<domain>`, deleted with the label or the PR.

Clusters describe themselves in their Argo CD cluster Secret, which OpenTofu writes:

| On the cluster Secret | Meaning |
|---|---|
| label `boilerplate.dev/managed: "true"` | gets the platform add-ons |
| label `boilerplate.dev/environment` | `staging`, `production` or `preview` |
| annotation `boilerplate.dev/cloud` | `aws`, `gcp`, `azure` or `other` (per-cloud values) |
| annotation `boilerplate.dev/domain` | the DNS zone its hosts are in |
| annotations `boilerplate.dev/environment`, `tls-email`, `dns01`, `secret-store`, `aws-region`, `gcp-project`, `azure-vault-url`, `azure-eso-client-id`, `image-policy` | the platform config's values |

Platform credentials live in the secret manager too: `platform/cloudflare-api-token`
(`{"token": …}`, Zone DNS edit) and, for previews, `platform/github-token`.
