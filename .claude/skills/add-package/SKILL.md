---
name: add-package
description: Create a new shared TypeScript package under packages/. Use when code is needed by more than one app or service and no existing package is the right home for it.
argument-hint: <name> "<what it is for>"
---

# Add a shared package

First check the existing packages (`packages/*/package.json` descriptions): a helper
that fits one of them goes there. Code for one service stays in that service.

1. `bun run gen:new package --args <name> "<one sentence: what it is for>"`, e.g.
   `bun run gen:new package --args money "Formatting and arithmetic for amounts of money."`
   It writes `packages/<name>/` (`package.json`: private, `type: module`, exports
   `./src/index.ts`, `check-types`/`test`/`coverage` scripts, `@repo/typescript-config`
   and `@repo/vitest-config`), adds `<name>` to the commit scopes in
   `commitlint.config.ts`, formats, and runs `bun install` to link it.
2. Write the code in `src/`, with a `*.test.ts` beside each file with logic. Raise the
   coverage floor in `vitest.config.ts` to what the tests reach.
3. Dependencies: `"catalog:"` when the root `package.json` catalog has the package,
   otherwise a normal range. Node types: add `@types/node` (`"catalog:"`) and
   `"compilerOptions": { "types": ["node"] }` to its `tsconfig.json`, like `packages/logger`.
   React code extends `@repo/typescript-config/react-library.json` instead.
4. Consumers add `"@repo/<name>": "workspace:*"` to their `package.json`, then
   `bun install`. Apps and mobile must not import server-only packages; if the new one
   is server-only, add it to the `web-has-no-backend-code` rule in `.dependency-cruiser.cjs`.
5. `bun run lint` (knip flags unused exports and undeclared dependencies),
   `bun run check-types`, `bun run test`.
6. Add `<name>` to the pull request title scopes in `.github/workflows/ci.yml` (the
   `pr-title` job's list, which repeats `commitlint.config.ts`'s), or a pull request
   titled with the new scope fails CI.
7. The `reviewer` agent on the change.
