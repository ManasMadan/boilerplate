---
paths:
  - "packages/client/**"
---

# packages/client

The data layer shared by web and mobile. Apps never create their own oRPC client or
call `fetch` against the API.

- One operation per file: `src/api/<area>/<operation>.ts`, imported by exact path
  (`@repo/client/api/todo/list`). There is no barrel for hooks.
- Hooks wrap the generated query utils: `const { api } = useApi()` then
  `useQuery(api.<ns>.<proc>.queryOptions(...))`, `.infiniteOptions(...)` or
  `.mutationOptions(...)`. Name them `use<Thing>Query`, `use<Thing>InfiniteQuery`,
  `use<Thing>Mutation`, matching the neighbouring files in the same area.
- Query keys come from the utils (`api.todo.list.key()`), never hand-written arrays.
- Optimistic updates keep the cache transform as a pure function in its own file with a
  unit test (see `src/api/todo/optimistic.ts`), then snapshot in `onMutate`, restore in
  `onError`, and invalidate in `onSettled`.
- Errors: branch on `errorCode(error)` and render `errorMessageKey(error)` through i18n
  (`src/errors.ts`). Never show `error.message`. Global cases (`UNAUTHENTICATED`,
  `CLIENT_OUTDATED`, `NO_ACTIVE_ORGANIZATION`) are handled once in `src/provider.tsx`.
- Shared form rules and auth error keys live in `src/auth/forms.ts`; web and mobile both
  use them, so do not copy validation into an app.
- Hooks are tested next to their file against the contract implemented in memory:
  `standIn((os) => ({ ... }))` with only the procedures the test calls, and `renderHook`,
  both from `test/stand-in.tsx`. Polling and reconnects run on fake timers, waited on
  with `until`.
- Must run in the browser and React Native: import contract types only, no Node APIs,
  nothing from `packages/db`, `nest-common` or `jobs`.
