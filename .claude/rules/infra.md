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
- Image tags in `deploy/environments/` are written by CI: staging's in its `stack.yaml`
  on every merge to master, production's with its revision in `release.yaml` through a
  promotion PR. Do not edit them by hand.
- OpenTofu: modules in `infra/tofu/modules/<name>` (k3s, cloudflare or rfc2136 for DNS, bootstrap), one root
  in `infra/tofu/envs/k3s` used per environment through tfvars. Every module has
  `tests/*.tftest.hcl` with `mock_provider`, so tests need no credentials.
  `bun run infra:check` runs fmt, validate and every test.
- Everything runs in the cluster: no managed databases, caches, storage, secret
  managers or mail services. Third-party APIs (AI providers, Twilio, push, Stripe,
  Google, Turnstile) and Cloudflare in front (optional: `dns.provider = "rfc2136"` runs
  without it) are the exceptions; ask before adding a
  managed dependency.
- Pin every version: images by tag (the Dockerfiles' base images by tag and digest,
  `scripts/dockerfiles.test.ts`), charts and providers by exact version. Anything
  Renovate cannot find on its own gets a comment on the line above:
  `# renovate: datasource=<docker|helm|github-releases|npm> depName=<name>` (see
  `infra/tofu/modules/bootstrap/variables.tf` and `.github/workflows/ci.yml`). A new
  file pattern needs a custom manager in `renovate.json5`.
- `bun scripts/misconfig.ts` (Trivy's `config` scan with `trivy.yaml`, as the Security
  workflow and the pre-commit hook run it) fails on any finding in the Dockerfiles,
  manifests, platform charts and OpenTofu: containers run as a UID and GID above 10000
  with CPU and memory limits, a chart's resources name `{{ .Release.Namespace }}`,
  images come from a registry in `deploy/trivy/registries.yaml`, and a long-running image
  has a HEALTHCHECK. A finding that doesn't apply goes under `misconfigurations` in
  `.trivyignore.yaml`, with its reason, for that one file. Trivy skips the stack and data
  charts (they need values it doesn't pass); `charts:check` validates those.
- Secrets never go in values files or tfvars. They're SOPS-encrypted Secrets in
  `deploy/environments/<env>/secrets/` and `deploy/platform/secrets/<env>/`, or generated
  in the cluster by the data chart; never decrypt one (rotate-secrets skill).
