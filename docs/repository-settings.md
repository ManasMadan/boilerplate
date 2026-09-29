# Repository settings

What GitHub needs to be set to for the workflows in `.github/workflows` to gate, ship and
release as intended. Nothing here is needed to develop locally; do it once, when the
repository starts shipping.

## Merging

**Settings → General → Pull Requests**

- Allow **squash merging** only, with the default message set to **pull request title**:
  the title is checked against Conventional Commits (the `pr-title` job), and it becomes
  the commit the release notes are built from.
- Enable **Automatically delete head branches**.

**Settings → Rules → Rulesets → New branch ruleset** for `master` (the default branch):

- Restrict deletions; block force pushes.
- Require a pull request before merging, with 1 approval, **Require review from Code
  Owners** (`.github/CODEOWNERS`), and dismissal of stale approvals on new commits.
- Require status checks to pass: **CI passed**, which succeeds only when every CI job
  does (see `ci.yml`), so adding a CI job never needs a change here; and from
  `security.yml`, **Secrets in the history**, **Dependency review** and **Known
  vulnerabilities (OSV)**.
- Require code scanning results: **CodeQL**, blocking on high or higher.
- Optional: **Require merge queue** (CI already runs on `merge_group`).
- Bypass list: the repository's GitHub App (below), so the staging bump can reach
  `master` without a pull request. Nobody else.

## The GitHub App

Workflows that write to the repository use a GitHub App's token instead of
`GITHUB_TOKEN`: pull requests opened with `GITHUB_TOKEN` never start CI (so dependency
pull requests could never pass **CI passed**), and `GITHUB_TOKEN` can't be put on the
ruleset's bypass list for the staging bump. Releases don't need it: you push the tag,
and `bun run promote` opens production's pull request as you. The same
App runs Renovate (`renovate.yml`, configured in `renovate.json5`).

1. **Settings → Developer settings → GitHub Apps → New GitHub App** (on your account or
   organization). No webhook. Repository permissions: **Contents**, **Pull requests**,
   **Issues** (Renovate's dependency dashboard) and **Workflows** (Renovate updates the
   pinned actions): Read and write; **Checks** and **Commit statuses**: Read. Only on
   this account.
2. Generate a private key, and install the App on this repository only.
3. In this repository: variable `BOT_APP_CLIENT_ID` (the App's client ID) and secret
   `BOT_APP_PRIVATE_KEY` (the key file's contents).
4. Add the App to the `master` ruleset's bypass list.

Without the App the deploy workflow falls back to `GITHUB_TOKEN` and say
so in a warning, and Renovate doesn't run.

## Environments

**Settings → Environments**

| Environment | Used by | Protection |
|---|---|---|
| `staging` | `deploy.yml` (the staging bump) | deployment branch `master` |
| `infra-staging`, `infra-production` | `infra.yml` (plan and apply) | required reviewers on production; deployment branch `master` for apply |

Production itself has no GitHub environment: it changes only by merging the promotion
pull request, which the ruleset already gates.

## Variables and secrets

**Settings → Secrets and variables → Actions.** Everything is optional; each feature is
skipped until its values exist.

| Name | Kind | For |
|---|---|---|
| `BOT_APP_CLIENT_ID`, `BOT_APP_PRIVATE_KEY` | variable, secret | the GitHub App above |
| `PREVIEW_DOMAIN` | variable | the preview link posted on pull requests (`preview.yml`) |
| `EVAL_MODEL` | variable | nightly evals against a real model, e.g. `anthropic:claude-sonnet-5` |
| `EVAL_EMBEDDINGS`, `EVAL_JUDGE_MODEL`, `EVAL_MIN_PASS_RATE`, `EVAL_MIN_RELEVANCE` | variables | the rest of the nightly evals' settings (`apps/ai/evals`) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | secrets | the providers those models use |
| `EAS_PROJECT_ID`, `EXPO_TOKEN` | variable, secret | mobile builds and over-the-air updates on EAS (`mobile.yml`; the project id from `bunx eas-cli init`, a robot token from expo.dev) |
| `LOAD_TARGET_RPS` | variable | the nightly load test's target (default 50 requests a second) |
| `TOFU_TARGETS` | variable | which environments get a plan on infrastructure pull requests, e.g. `["staging", "production"]` |

Per `infra-<env>` environment, for `infra.yml` (see the header of that workflow and
`infra/tofu/README.md`), all secrets:

| Name | What |
|---|---|
| `TOFU_BACKEND` | the contents of `backend-<env>.hcl` (the state bucket and its keys) |
| `TOFU_TFVARS` | the contents of `<env>.tfvars` (the machines, domain, mail) |
| `SSH_PRIVATE_KEY` | the key the environment's machines accept |
| `CLOUDFLARE_API_TOKEN` | the zone's token (permissions in `infra/tofu/modules/cloudflare`) |
| `SOPS_AGE_KEY` | the environment's age private key, installed for Argo CD |
| `TF_VAR_state_passphrase` | encrypts the state and plans |

The runner connects to the machines over SSH and to the Kubernetes API (ports 22 and
6443): allow GitHub's runner addresses in the machines' firewall, or give the
environment a self-hosted runner inside your network.

## Security

**Settings → Advanced Security**

- Enable **Private vulnerability reporting** (`SECURITY.md` points reporters to it).
- Enable **Dependency graph** (dependency review needs it) and **Secret scanning** with
  **Push protection**.
- Code scanning is uploaded by `security.yml`; leave the default CodeQL setup off.

## Packages

Images are pushed to `ghcr.io/manasmadan/boilerplate/*` by `deploy.yml` and
`preview.yml`. After the first push, in each package's settings, link it to this
repository (**Manage Actions access → Write** for this repository) so later runs can
push, and choose its visibility. If the packages stay private, give the clusters a pull
secret and list it in the stack chart's `image.pullSecrets`.
