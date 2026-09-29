# Deploying

How code gets from a merge to running clusters. The charts, environments and GitOps
layout are in [deploy/README.md](../deploy/README.md), the clusters and cloud resources
in [infra/tofu/README.md](../infra/tofu/README.md), and the GitHub settings the workflows
need in [repository-settings.md](repository-settings.md).

## Images

`docker-bake.hcl` defines every image: `api`, `worker`, `notifications` and `webhooks`
(one Dockerfile, `deploy/docker/node-service.Dockerfile`), `web`, `ai` (also runs the AI
worker) and `migrate` (`prisma migrate deploy`). Images are `<REGISTRY>/<name>:<TAG>`,
with `RELEASE` (the commit SHA in CI) stamped in, so logs, errors and the web app report
which build is running.

```sh
docker buildx bake              # every image, for this machine
docker buildx bake api web      # some of them
```

On every pull request CI's **Container images** job builds them all and fails on a fixable
critical or high vulnerability (Trivy).

## Environments

| Environment | Where | Changes when |
|---|---|---|
| local | kind on your machine (`bun run k8s:up`, `k8s:smoke`, `k8s:down`) | you run it |
| preview | a namespace per labelled pull request, on the cluster that hosts previews | the pull request is pushed to |
| staging | its own cluster | every merge to `master` |
| production | its own cluster | a promotion pull request is merged |

Each has its values in `deploy/environments/<env>/` (`data.yaml`, `stack.yaml`). Argo CD
installs the `data` release (Postgres, Valkey) before `stack`, and the stack's migration
Job runs before its services on every sync. Migrations are expand-then-contract
([database.md](database.md#expand-then-contract)), so the previous release keeps working
against the new schema during a rollout and after a rollback.

## master → staging

`.github/workflows/deploy.yml`, after CI succeeds on a push to `master`:

1. builds every image for amd64 and arm64 and pushes them to
   `ghcr.io/manasmadan/boilerplate/<image>:sha-<commit>`;
2. merges them into multi-arch tags, signs each with cosign (keyless) and attaches build
   provenance and an SBOM; production's image policy admits only images this workflow
   signed on `master`;
3. commits the new tag to `deploy/environments/staging/stack.yaml` (as the repository's
   GitHub App, `[skip ci]`), and Argo CD rolls it out.

## Releases → production

`.github/workflows/release.yml`: release-please keeps a release pull request open with
the next version and changelog, built from the Conventional Commit titles since the last
release. Merging it tags the version, and the workflow then opens a promotion pull
request (`release/production-v<version>`) that sets `image.tag` in
`deploy/environments/production/stack.yaml` to that commit's images, the ones already
running on staging. Merging the promotion is the deploy.

The mobile app follows the same events on EAS (`mobile.yml`, see
[web-and-mobile.md](web-and-mobile.md#eas-builds-and-over-the-air-updates)).

## Rollback

Argo CD syncs automatically and self-heals, so a change made in the cluster is undone;
roll back in git:

- **Production**: revert the promotion commit on `master` (through a pull request), or
  open one setting `image.tag` back to the previous `sha-<commit>`.
- **Staging**: revert the bump commit, or let the next merge replace it.

The database isn't rolled back: the previous release already works with the current
schema. If a migration itself is wrong, fix forward with a new one.

## Previews

Adding the `preview` label to a pull request from this repository (not a fork) runs
`.github/workflows/preview.yml`: it builds the head commit's images (amd64) as
`sha-<commit>` and comments the address, `https://pr-<number>.preview.<domain>` (the
`PREVIEW_DOMAIN` repository variable). Argo CD's previews ApplicationSet deploys it to its
own namespace with its own database and Valkey. New pushes rebuild; removing the label or
closing the pull request deletes it.

## Infrastructure

`.github/workflows/infra.yml` posts a `tofu plan` on pull requests that change
`infra/tofu`, for each environment in the `TOFU_TARGETS` repository variable. Applying is
a manual run (cloud, environment, apply), gated by the GitHub environment's reviewers.

`kind.yml` deploys the whole stack to kind and smoke-tests the routes when images, charts
or migrations change, and nightly.
