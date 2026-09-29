---
paths:
  - "apps/api/src/**"
  - "apps/api/test/**"
---

# apps/api modules

- A feature is `src/modules/<name>/` with `<name>.module.ts`, `.service.ts`,
  `.repository.ts`, `.router.ts` and an `index.ts` barrel. `modules/todo` is the
  reference; copy its shape. Register the module in `app.module.ts` and its router in
  `src/rpc/router.ts` (`os.router` makes a missing or extra procedure a compile error).
- Other modules import a module only through its `index.ts` (dependency-cruiser
  `api-modules-only-via-barrel`).
- Routers are thin: pick the procedure builder, call the service, nothing else.
- Pick the narrowest builder from `src/rpc/procedures.ts`: `base` (public), `authed`,
  `fresh` (recent sign-in, for account changes), `inOrg` (tenant data), `orgAdmin`
  (owner/admin). Never re-implement session or membership checks in a service.
- Repositories are the only code that touches Prisma. Reads use
  `withTenant(this.database.read, orgId)`; writes run inside
  `tenantTx(this.database.write, orgId, ...)` and take the `Tx`. Per-user rows use
  `withUser` / `userTx`. Never query tenant tables with the bare client: RLS returns
  nothing, which looks like "not found", not like a bug.
- Inside `tenantTx`/`userTx` only database calls. No HTTP, Redis or queue awaits: the
  transaction holds a pooled connection and times out after 5s.
- Domain events: `emitEvent(tx, "<name>.v1", payload)` from `src/outbox.ts`, in the same
  transaction as the change. Time-critical notifications (codes, invitations) go
  straight to the `notifications-critical` producer (`src/notifications.ts`).
- Errors: `throw new AppError("CODE", { params })` from `@repo/nest-common`. Codes live
  in `packages/contracts/src/errors.ts`; never throw bare `Error` for an expected case
  and never put user-facing text in errors.
- Rate limits are per operation: `createRateLimiter` from `@repo/nest-common`, throwing
  `RATE_LIMITED` with `retryAfterSeconds`. Anything that costs money or sends messages
  needs one.
- Paid features check `BillingService.require(orgId, entitlement)`. Optional features
  are on only when their env is set (`src/features.ts`) and otherwise answer
  `FEATURE_DISABLED`.
- Tests: unit tests next to the code as `src/**/*.test.ts` (no services). Anything that
  touches the database, Redis, auth or email goes in `test/*.integration.test.ts` using
  `test/harness.ts` (`startApi`, `createSession`, `takeNotification`) and factories
  from `@repo/db/testing`.
