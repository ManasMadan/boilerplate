---
name: add-feature
description: Add a product feature end to end (API contract, apps/api module, client hook, web page, tests). Use when the user asks for a new resource, endpoint, screen or CRUD flow backed by the database.
---

# Add a feature

The todo feature is the reference for every layer: copy its shape, not just its names.

1. **Table.** If the feature stores data, add the model first (db-change skill): tenant
   table with `org_id`, forced row-level security and grants, then `bun run gen`.
2. **Scaffold.** `bun run gen:new api-feature --args <name> <item> <model>`, e.g.
   `bun run gen:new api-feature --args projects project project` (`<model>` is the
   Prisma client accessor). It writes and wires:
   - `packages/contracts/src/api/<name>.ts`, registered in `packages/contracts/src/api/index.ts`
   - `apps/api/src/modules/<name>/` (module, repository, service, router, index), registered
     in `apps/api/src/app.module.ts` and `apps/api/src/rpc/router.ts`
   - `packages/client/src/api/<name>/list.ts` (an infinite-query hook)
   - a `describe` block at the end of `apps/api/test/api.integration.test.ts`
   The scaffold is one `list` procedure that returns `id` and `createdAt`; everything
   else is yours.
3. **Contract.** Add the fields to the item schema and the writes (`create`, `update`,
   `delete`) with input schemas and limits, like `packages/contracts/src/api/todo.ts`.
   New error codes go in `packages/contracts/src/errors.ts` and `errors.<CODE>` in every
   `packages/i18n/messages/*.json`. For API-key access, add a scope to
   `packages/contracts/src/api/scopes.ts` and describe it under `workspace.apiKeys.scopes`.
4. **API.** Repository: every query through `withTenant`/`tenantTx`, `read` for lists,
   `write` for changes. Service: each change and its domain event (`emitEvent`, events
   declared in `packages/contracts/src/events.ts`, described under
   `workspace.audit.events` in i18n) in one `tenantTx`. Router: one line per procedure;
   `inOrg`, `orgAdmin` or `fresh` from `apps/api/src/rpc/procedures.ts`.
5. **Client.** One hook per procedure under `packages/client/src/api/<name>/`, with
   optimistic updates like `packages/client/src/api/todo/` (pure cache transforms in
   their own file, unit-tested).
6. **Web.** A module in `apps/web/src/modules/<name>/` (components, pages, `index.ts`) and
   a route in `apps/web/src/app/(app)/<name>/page.tsx` that re-exports the page with
   `pageTitle(...)`. Data only through `@repo/client` hooks; forms validate with the
   contract's input schema (see `apps/web/src/modules/dashboard/components/todo-list.tsx`).
   Every string through `packages/i18n`, in every locale.
7. **Tests.** Extend the generated block in `apps/api/test/api.integration.test.ts`:
   happy path, typed errors, and another organization seeing nothing. A user flow gets
   a spec in `apps/web/e2e/` (see `todos.spec.ts`).
8. `bun run gen` (the OpenAPI document changes), then the verify skill.
