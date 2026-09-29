---
name: swap-read-replicas
description: Send read queries to Postgres read replicas. Use when the primary database is saturated by reads, or the user asks about read replicas or splitting reads and writes.
---

# Add read replicas

- **Interface:** `Database` (`read`, `write`, `disconnect`) in `packages/db/src/client.ts`.
- **Today:** `createDatabase` returns the same primary client for `read` and `write`.
  Repositories already choose per query: `read` for lists and dashboards that tolerate
  lag, `write` for changes and any read that must see them.
- **Provided by** `DatabaseModule.forRoot` (`packages/nest-common/src/database.ts`),
  called in each service's `src/app.module.ts` (api, worker, notifications, webhooks).
- **Env:** `<SERVICE>_DATABASE_URL` and `<SERVICE>_DATABASE_POOL_MAX` from `databaseEnv`
  in `packages/nest-common/src/env.ts`.

## Swap

1. In `createDatabase`, build `read` from a replica URL when one is given (a second
   `createDb`, or Prisma's read-replicas extension on the primary), and disconnect both.
   Row-level security works the same: policies and grants replicate.
2. Add an optional `<SERVICE>_DATABASE_REPLICA_URL` to `databaseEnv`, pass it through
   `DatabaseModule.forRoot` in each service that wants it, and document it in
   `.env.example` and `docs/environment.md`. Unset keeps today's behaviour.
3. Deployed: the replica's URL per role in the `db-<role>` secrets (the data chart,
   `deploy/charts/data`) and its pooler.
4. Audit reads that follow a write in the same request: they must use `write`
   (`database.write` or inside the `tenantTx`), or the user sees stale data.

The Python service (`apps/ai/app/db/session.py`) has one engine; it's separate.

## Tests

`packages/db/test/security.test.ts` (row-level security and privileges). Integration
suites run with `read` equal to `write`; add a test that points `read` at a separate
client and checks a repository's read-after-write paths use `write`.
