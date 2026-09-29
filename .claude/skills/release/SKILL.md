---
name: release
description: Cut a release and put it in production. Use when the user asks to release, tag a version, write the changelog, promote to production, or what's in the next version.
---

# Release to production

1. **Release pull request.** release-please (`.github/workflows/release.yml`,
   `release-please-config.json`) keeps a pull request open on `master` with the next
   version and the changelog, built from the Conventional Commit titles merged since
   the last release (`feat` and `fix` bump the version and appear in it).
   `gh pr list --label "autorelease: pending"` finds it.
2. **Tag.** Merging it tags the version (`.release-please-manifest.json` records it).
3. **Promotion pull request.** The same workflow then opens
   `chore(infra): deploy v<version> to production` from branch
   `release/production-v<version>`: it sets `image.tag` in
   `deploy/environments/production/stack.yaml` to that release commit's images
   (`sha-<commit>`), the ones staging already runs once deploy.yml has finished for it.
4. **Deploy.** Check the release commit's Deploy run passed
   (`gh run list --workflow deploy.yml`) and staging is healthy, then merge the
   promotion pull request. Argo CD syncs `production-data` and `production-stack`;
   production admits only images deploy.yml signed on `master`.
5. Watch it as in the deploy skill, with the production cluster's context.

Undoing a release: the rollback skill.
