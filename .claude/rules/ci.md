---
paths:
  - ".github/**"
---

# GitHub Actions

- Every action is pinned by commit SHA with its version in a comment
  (`uses: actions/checkout@<sha> # v7.0.1`); Renovate updates both. Never a tag or a
  branch.
- Least privilege: the workflow sets `permissions: {}` and each job asks for exactly
  what it uses (`contents: read`, and more only where it writes). `actions/checkout`
  always with `persist-credentials: false`: a job that pushes hands its token to the
  fetch and push themselves (deploy.yml's staging bump), so it never sits in
  `.git/config` (`scripts/workflows.test.ts` checks).
- `bun run lint` runs actionlint and zizmor over the workflows (`scripts/linters.ts`).
  A finding is fixed, not ignored; the rare exception is a `# zizmor: ignore[<audit>]`
  with a row in docs/testing.md's Suppressions table saying why.
- The first step of every job is `step-security/harden-runner` (`scripts/workflows.test.ts`
  refuses a job without it). A job whose traffic is known runs it with
  `egress-policy: block` and its `allowed-endpoints`; the rest run `audit`. To move one to
  block: open a recent run of the job on master, follow the harden-runner link in the
  job's summary (StepSecurity's insights for that run), check the outbound calls it lists
  over a few runs (a nightly one too, if the job does more then), put those hosts in
  `allowed-endpoints` and switch the policy. A new tool that downloads something then
  needs its host added in the same change, or the job fails at that step.
- Every job has a `timeout-minutes`, sized to about twice its normal run
  (`scripts/workflows.test.ts` refuses a job without one).
- Toolchain through `./.github/actions/setup` (Node from `.nvmrc`, Bun from
  `package.json`, uv on request, Bun's download cache and the Turborepo cache), not a
  job's own setup steps. A job
  that runs turbo asks for uv (`python: "true"`): tasks depend on `^gen`, which reaches
  the Python service's `gen` through the AI client (`scripts/workflows.test.ts` checks).
- Only gates are required checks: one per workflow that can block a pull request
  (**CI passed**, **Security passed**, **Kubernetes passed**, **Infrastructure passed**),
  each `if: always()` and needing every other job of its workflow, and none behind a path
  filter (a job that has nothing to do is skipped by a `changes` job instead, so the gate
  still reports). A new job goes in its workflow gate's `needs`, so the ruleset never
  changes; `scripts/workflows.test.ts` fails otherwise. In `ci.yml` that gate is `ci-ok`. A heavy one also `needs: changes` and runs only for the
  areas it checks (`if: needs.changes.outputs.<area> == 'true'`, areas in
  `scripts/changes.ts`), with the same areas in `ci-ok`'s `$gates`
  (`scripts/workflows.test.ts` fails when the two disagree). Jobs run the same commands a developer runs locally
  (`bun run lint`, `bun run test:integration`, …), never a CI-only variant.
- Commit and pull request title scopes are the workspace folder names plus a few
  cross-cutting ones, all in `commitlint.config.ts`; CI checks titles with that config,
  so there's no second list to keep in step.
- Secrets reach only the steps that need them, as `env` on the step, and are never
  echoed. Code from a fork's pull request never runs with secrets: no
  `pull_request_target` job that checks out the pull request's head, and a
  `workflow_run` job that checks out the run's commit runs only when that run was this
  repository's own push (`workflow_run.event == 'push'` and
  `workflow_run.head_repository.full_name == github.repository` in its `if`;
  `scripts/workflows.test.ts` checks).
- Pinned tool versions in workflows carry a `# renovate:` comment on the line above.
- Changing a workflow changes how everything ships: say what it changes and why, and
  let the user decide.
