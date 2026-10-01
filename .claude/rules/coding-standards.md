---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.py"
---

# Coding standards (TypeScript and Python)

The principles in `CLAUDE.md` apply everywhere; this is what they mean line by line.

- **No escape hatches.** No `any`, `as any`, `as unknown as`, `@ts-ignore`,
  `@ts-expect-error`, non-null `!` on a value that can be missing, `# type: ignore`,
  bare `# pyright: ignore`, `# noqa`, or `biome-ignore`. A new one is refused by the edit
  hook unless `docs/testing.md` lists the file with its reason. Fix the type instead. An
  implicit `any` counts too (a library's loose result, `instanceof` on a generic class,
  a `Job` without its type argument): `bun run type-coverage` fails on any in the source,
  in CI's type-check job. Make it `unknown` and parse it, or give it its type.
- **Parse, don't cast.** Data from outside the process (HTTP, queues, env, files, third
  parties, the database's JSON columns, other services) goes through a schema (zod,
  Pydantic) at the boundary; inside, types come from those schemas. No hand-written
  duplicate of a schema's type. `bun run lint:patterns` refuses `JSON.parse(...) as T`,
  `(await res.json()) as T`, `$queryRaw<T>` and optional chains three deep in `src/`.
- **No silent fallbacks.** `??` and `||` only where the default is the intended value,
  never to hide missing data; an unexpected case throws or returns a typed error.
  Every `catch` either handles the error, rethrows it, or logs it with context; never
  an empty one.
- **Errors are codes.** Expected failures are `AppError` with a code from
  `packages/contracts/src/errors.ts` (Python: `app/errors.py`). No user-facing text in
  errors or logs.
- **Reuse.** Before writing a helper, search `packages/` (and `scripts/lib.ts` for
  scripts). One implementation per concern.
- **Small and plain.** Functions do one thing; no speculative options, factories or
  interfaces with one implementation, except the seams the README lists. Names say what
  a thing is; no abbreviations a reader has to decode. Biome holds every TypeScript
  function to a cognitive complexity of 15 and (outside tests) 60 lines, and refuses
  nested ternaries and reassigned parameters (biome.jsonc): split the function into named
  steps, an early return or a lookup table; never raise a limit to fit one.
- **Comments say why**, in plain prose: the constraint, the trade-off, the limit and
  what to do when it's reached. Not what the next line does, not decision IDs, not a
  personal tool's markers (`bun run lint:markers` refuses `ponytail:`).
- **Tests come with the change**, of the kind `.claude/rules/tests.md` says; a bug fix
  starts with a failing test.
- **Formatting is Biome's and ruff's** (`bun run format`); don't hand-format against
  them.
