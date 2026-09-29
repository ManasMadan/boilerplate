# Boilerplate

Full-stack monorepo: a hackathon starter built to production standards. Everything is
driven by `bun` scripts, and every common task has a skill in `.claude/skills/`.

## Commands

| Task | Command |
|---|---|
| First-time setup (idempotent) | `bun run setup` |
| Health check (tools, .env drift, services) | `bun run doctor` |
| Develop (core profile: web, api, notifications, worker, webhooks) | `bun dev` |
| Develop with every service (AI, files, billing, …) | `bun dev:full` |
| Lint, formatting, architecture boundaries | `bun run lint` (`bun run format` to fix) |
| Types | `bun run check-types` |
| Unit tests (fast, cached) | `bun run test` |
| Integration tests (real Postgres/Valkey/Mailpit) | `bun run test:integration` |
| Regenerate code (Prisma client, API/AI clients) | `bun run gen` |
| New database migration | `bun run db:migrate` |
| Set a secret in .env (you cannot read .env) | `bun run env:set KEY=value` |

Run commands from the repo root. Never `cd` into a package to run tools directly; for one
package use `bun run --filter @repo/<name> <script>` (or `bun run --cwd <dir> <script>`).

Local services (Docker, host ports): Postgres 55432, Valkey 56379, Mailpit 58025 (SMTP
51025), RustFS 59000 (console 59001), ClamAV 53310; opt-in, the Stalwart mail server
(`bun run db:up:mail`): submission 51465, management 58080. Web is on 3000, api 3001, worker
3002, notifications 3003, webhooks 3004, ai 8000.

## Principles (non-negotiable)

1. **Fix root causes.** No workarounds, no `as any`, no `@ts-ignore`, no disabling a
   lint rule to get green. If the design forces a workaround, change the design.
2. **Validate at every boundary**: env (t3-env), HTTP input (contract schemas), queue
   payloads (`parseJob`), cross-service data. Types come from schemas, never duplicated.
3. **One implementation per concern.** Before writing a helper, search `packages/` for it.
4. **Seams, not rewrites.** Integrations that will change at scale (translations,
   templates, email/SMS/push providers, storage, search, queues) sit behind one
   interface. Call the interface, never the provider. Each seam's file documents how to
   swap it; the full list is in README "Scaling path".
5. **Services never import each other.** They share `packages/*` and talk through the
   API contract, queues and events. `bun run lint:boundaries` enforces this.
6. **Every user-facing string goes through `packages/i18n`** (UI, emails, push, SMS).
7. Comments explain *why*, in plain prose. No decision IDs, no "as discussed".

## Layout

- `apps/web` Next.js, render-only (no route handlers or server actions; enforced)
- `apps/api` NestJS on Fastify: auth (better-auth) and the oRPC API
- `apps/notifications` NestJS worker: every notification channel
- `apps/worker` NestJS: outbox relay, audit log, scheduled jobs
- `apps/webhooks` NestJS: inbound provider webhooks and outbound delivery
- `apps/ai` Python (FastAPI, Pydantic AI, LangGraph, BullMQ worker)
- `apps/mobile` Expo
- `packages/contracts` API contract, input schemas, limits, error codes
- `packages/client` data hooks for web and mobile (the only way apps call the API)
- `packages/db` Prisma schema, migrations, client factory
- `packages/nest-common` shared Nest plumbing (env fragments, db, redis, logging, health,
  outbox, `safeFetch`, rate limits, encryption, storage)
- `packages/jobs` queue contracts and producer
- `packages/i18n` every translation; `packages/email` email templates; `packages/ui` components

## Working rules

- Libraries change faster than your training data. For Next.js, Turborepo and other tools
  that bundle docs, read the installed version's docs first:
  `node_modules/next/dist/docs/`, `node_modules/turbo/docs/`.
- Generated files (`**/generated/**`, `*.gen.ts`, `openapi.json`, `apps/ai/app/contracts/`),
  applied migrations, lockfiles and `.env` are never edited by hand; hooks block most of
  them. Change the source and regenerate.
- When you finish a change, the Stop hook runs types and unit tests for affected
  packages (plus ruff for `apps/ai`). It does not run Biome or the boundary checks: run
  `bun run lint` yourself. For anything touching the database, queues or HTTP, also run
  the `verify` skill.
- Commits: Conventional Commits with a workspace scope, e.g. `feat(api): add todo sharing`.
- New environment variables go in the service's `src/env.ts`, `.env.example`, and
  docs/environment.md, in the same change.

## Claude Code setup

- `.claude/rules/`: per-area rules that load when you open matching files (api,
  contracts, client, web, db, jobs and events, notifications, python, infra, tests,
  i18n, security). Each app and `packages/db` also has its own `CLAUDE.md`.
- `.claude/agents/`: `reviewer`, `security-reviewer`, `migration-reviewer` and
  `verifier`. Use them before calling a change done.
- `.claude/skills/`: step-by-step procedures (setup, dev, verify, ...).
- `.mcp.json`: Playwright for driving the local web app, and read-only Postgres on the
  local `app` database. The Postgres server connects as `app_api` (a local-only
  password equal to the role name, from `infra/postgres/init`) in restricted mode, so
  it runs read-only transactions and sees only what RLS allows: tenant and per-user
  tables show no rows unless `app.org_id` / `app.user_id` is set in the same
  transaction. Use it for schemas, indexes and query plans. It needs `bun run db:up` and
  `uv`.
