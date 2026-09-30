---
paths:
  - "scripts/**"
---

# scripts/

The repo's own commands, run with Bun from the root (`bun scripts/<name>.ts`, usually
behind a `package.json` script).

- Each script starts with a comment saying what it does, how to run it, and what it
  needs. Shared helpers are in `scripts/lib.ts` (`ROOT`, `ok`/`warn`/`fail`, `.env`
  reading and writing): use them, don't copy them.
- A script's work is an exported function that takes what it touches as parameters,
  with the real ones as defaults: the command runner (`runSync` in `scripts/lib.ts`),
  argv, the environment, file paths. `if (import.meta.main)` is one line that calls it
  and exits with its code. Tests are `scripts/<name>.test.ts` with `bun:test`, run by
  `bun test ./scripts/` (the pre-push hook and CI's unit job), and never run Docker,
  kind, psql or anything else that changes the machine: `fakeRun` in
  `scripts/stand-ins.ts` records the commands instead, `captureOutput` what's printed,
  and files and git repositories are temporary ones. Non-trivial logic gets a test.
- Types: `tsc -p scripts` (part of `bun run check-types`); new files are covered by
  `scripts/tsconfig.json` automatically. knip treats every `scripts/*.ts` as an entry.
- A script never prints a secret and never reads `.env` values it doesn't need;
  `readEnv` for what it does. Failures exit non-zero with a message that says how to fix
  them.
- Pinned tool versions and images in a script carry a `// renovate:` comment (or match
  the image manager in `renovate.json5`), so Renovate moves them.
- Commands that change something outside the repo (push, open a pull request, delete
  Docker volumes, touch a cluster) are listed in the Bash guard's destructive scripts
  (`.claude/hooks/shell.ts`), so an agent asks first; a new one needs an entry there,
  which is a change to the guard rails the user approves.
