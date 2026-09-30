# Contributing

## Getting started

You need Node 24 (`nvm use`), Bun 1.3, Docker and, for the AI service, uv.

```sh
bun run setup      # once: .env with generated secrets, dependencies, database
bun dev            # the core services; `bun dev:full` for everything
bun run doctor     # when something looks off
```

Local services run in Docker with small memory limits and their own ports, so they sit
beside other projects' containers. `bun run db:down` stops them; `bun run docker:clean`
removes everything this repository created in Docker.

## Making a change

1. Branch from `master`: `feat/<what>`, `fix/<what>`, `chore/<what>`.
2. Keep to the principles in `CLAUDE.md`: fix root causes, validate at every boundary,
   one implementation per concern, services never import each other, and every
   user-facing string goes through `packages/i18n`.
3. Before pushing: `bun run lint`, `bun run check-types`, `bun run test`, and for
   anything touching the database, queues or HTTP, `bun run test:integration`. The git
   hooks help: on commit they format and lint the staged files (Biome, ruff, Prisma,
   `tofu fmt`, Squawk on migrations) and scan them for secrets with gitleaks (installed,
   or through Docker); on push they run types and unit tests for the packages you
   changed and the repo's scripts and Claude Code hooks.
4. Open a pull request. Its title becomes the squashed commit, so it follows
   [Conventional Commits](https://www.conventionalcommits.org) with a workspace scope:
   `feat(api): add todo sharing`, `fix(web): keep the draft on reload`. The scopes are in
   `commitlint.config.ts`. `feat` and `fix` end up in the changelog and the next version.

CI must pass (the **CI passed** check). With a single maintainer the ruleset asks for no
approval (GitHub doesn't let you approve your own pull request); once there's a team, it
asks for one from a code owner (docs/repository-settings.md).

## Database changes

- Change the schema in `packages/db/prisma/schema/` (one file per area), then
  `bun run db:migrate` to write the migration. Never edit a migration that has shipped;
  write a new one.
- Migrations deploy before the code that uses them, and the previous release keeps
  running during a rollout, so every migration must work with both. Add first, backfill,
  switch the code, and drop in a later release. `bun run db:lint` (squawk) catches the
  locking and rewriting operations that would take production down.
- Tenant tables get forced row-level security and grants for the roles that need them,
  in the same migration. The integration tests connect as those roles, so a missing
  grant or policy fails there.

## Environment variables

A new variable goes in the service's `src/env.ts` (validated at boot), `.env.example`
and `docs/environment.md`, in the same change. Features switch on when their variables
are present, so a new integration stays off until it's configured.

## Releases

Every merge to `master` deploys to staging. A release is a version tag you push
(`git tag v1.4.0 && git push origin v1.4.0`): the release notes are built from the
commit titles since the last tag. `bun run promote v1.4.0` then opens the pull request
that points production at that version's images; merging it deploys. See
`docs/deploy.md`.

## Security issues

Never in a public issue: see [SECURITY.md](SECURITY.md).
