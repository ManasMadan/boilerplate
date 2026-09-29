---
name: rollback
description: Roll an environment back to the previous version after a bad deploy. Use when production or staging is broken after a release, the user says roll back or revert a deploy, or a migration or image is failing in a cluster.
---

# Roll back

Environments run whatever `image.tag` says in `deploy/environments/<env>/stack.yaml` on
`master`; Argo CD syncs automatically and self-heals, so a rollback is a commit, never a
change made in the cluster (Argo CD's own rollback is refused while automated sync is on).

## Production

1. Find the promotion commit to undo:
   `git log --oneline -- deploy/environments/production/stack.yaml`.
2. Revert it on a branch and open a pull request:
   `git revert <commit>`, then a PR titled `revert(infra): deploy v<version> to production`.
   Or set `image.tag` back to the previous `sha-<commit>` by hand in that file.
3. Merging it deploys the previous images. Check with the deploy skill's commands.

## Staging

Reverting the staging bump doesn't stick: the revert is itself a push to `master`, so
deploy.yml builds that commit and moves staging to it, with the same code. Revert the
change that broke it instead (`git revert <merge commit>` in a PR); its deploy is the
rollback.

## The database

Migrations are never rolled back. Because every migration is expand-then-contract (the
db-change skill), the previous release runs on the new schema. A migration that fails
stops the rollout before any service changes; fix it forward with a new migration.
