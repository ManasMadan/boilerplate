---
paths:
  - "packages/contracts/**"
  - "apps/api/openapi.json"
---

# packages/contracts

The contract is the public API: web, mobile, the REST API at `/api/v1` and old mobile
builds in the field all depend on it.

- New procedures copy `src/api/todo.ts`: limits as `SCREAMING_CASE` consts, an output
  schema with its inferred type, input schemas, then
  `base.meta(...).route({ method, path, tags, summary }).input(...).output(...)`.
  Register the file in `src/api/index.ts`.
- Every input has bounds: max lengths, `PAGE_SIZE_MAX`, enums instead of free strings.
  Lists use `pageInput` / `page(item)` from `src/pagination.ts` (cursor only).
- API keys: a procedure callable with a key sets `base.meta({ apiKeyScope: "..." })`
  with a scope from `API_KEY_SCOPES` in `src/api/scopes.ts`. No scope means keys get
  `FORBIDDEN`. Add a scope only for data a third party should reach.
- Error codes: add to `ERROR_CODES` in `src/errors.ts` with the HTTP status, and add
  `errors.<CODE>` to every catalog in `packages/i18n` in the same change. `params` are
  ICU arguments: strings and numbers only.
- Events (`src/events.ts`): names are versioned (`todo.completed.v1`). Adding an
  optional field is compatible; anything else is a new `.v2` published alongside the old
  one. Consumers must be idempotent and order-independent. Only events in
  `webhookEvents` reach customers.
- Never break `/api/v1`. Removing a field, renaming, narrowing a type or adding a
  required input fails the `api-compat` CI job (oasdiff against the base branch's
  `apps/api/openapi.json`). Add instead: new optional fields, new procedures. A real
  breaking change needs a `!` in the PR title and ships as a major version.
- After any change run `bun run gen`, and commit the regenerated `apps/api/openapi.json`
  (the `codegen` CI job fails otherwise).
- This package depends on `@orpc/contract` and `zod` only. No server code, no Node APIs:
  web and mobile bundle it.
