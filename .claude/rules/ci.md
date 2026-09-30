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
  with `persist-credentials: false` unless the job pushes.
- The first step of every job is `step-security/harden-runner`.
- Every job has a `timeout-minutes`, sized to about twice its normal run
  (`scripts/workflows.test.ts` refuses a job without one).
- Toolchain through `./.github/actions/setup` (Node from `.nvmrc`, Bun from
  `package.json`, uv on request, the Turborepo cache), not a job's own setup steps.
- A new CI job goes in `ci-ok`'s `needs` list, the one required check, so branch
  protection never changes. A heavy one also `needs: changes` and runs only for the
  areas it checks (`if: needs.changes.outputs.<area> == 'true'`, areas in
  `scripts/changes.ts`), with the same areas in `ci-ok`'s `$gates`
  (`scripts/workflows.test.ts` fails when the two disagree). Jobs run the same commands a developer runs locally
  (`bun run lint`, `bun run test:integration`, …), never a CI-only variant.
- The pull request title scopes in `ci.yml` repeat `commitlint.config.ts`: change both
  together.
- Secrets reach only the steps that need them, as `env` on the step, and are never
  echoed. Code from a fork's pull request never runs with secrets: no
  `pull_request_target` job that checks out the pull request's head.
- Pinned tool versions in workflows carry a `# renovate:` comment on the line above.
- Changing a workflow changes how everything ships: say what it changes and why, and
  let the user decide.
