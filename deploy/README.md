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
