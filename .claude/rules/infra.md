---
paths:
  - "deploy/**"
  - "infra/**"
  - "docker-bake.hcl"
  - "renovate.json5"
---

# deploy/ and infra/tofu

Never run `helm install/upgrade`, `kubectl apply`, `tofu apply` or anything that changes
a real cluster or cloud account. The checks below are offline.

- Helm charts are `deploy/charts/stack` and `deploy/charts/data`. Both
  `values.schema.json` files set `additionalProperties: false`: a new value needs its
  schema entry, or `helm template` fails.
- Every template change gets a helm-unittest case in `deploy/charts/<chart>/tests/`.
- Environments are `deploy/environments/<env>/{data,stack}.yaml`. A new environment
  must also be added to `RELEASE_VALUES` in `scripts/charts.ts`.
- `bun run charts:check`: lint, unit tests, every environment rendered and validated
  with kubeconform, platform add-ons at their pinned versions, Argo CD manifests. Needs
  helm with the helm-unittest plugin.
- Image tags in `deploy/environments/` are written by CI: staging on every merge to
  master, production through a promotion PR. Do not edit them by hand.
- OpenTofu: modules in `infra/tofu/modules/<name>`, roots in `infra/tofu/envs/<cloud>`.
  Every module has `tests/*.tftest.hcl` with `mock_provider`, so tests need no
  credentials. `bun run infra:check` runs fmt, validate and every test, and checks that
  the aws, gcp and azure modules expose the same outputs.
- Pin every version: images by tag, charts and providers by exact version. Anything
  Renovate cannot find on its own gets a comment on the line above:
  `# renovate: datasource=<docker|helm|github-releases|npm> depName=<name>` (see
  `infra/tofu/modules/bootstrap/variables.tf` and `.github/workflows/ci.yml`). A new
  file pattern needs a custom manager in `renovate.json5`.
- Secrets never go in values files or tfvars. Charts read them through External
  Secrets; OpenTofu generates them (`infra/tofu/modules/app-secrets`).
