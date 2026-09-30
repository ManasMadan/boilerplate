---
name: verify
description: Prove a change works before calling it done. Use after implementing a feature or fix that touches the database, queues, emails, auth or HTTP endpoints, before opening a PR, or when the user asks to test everything.
---

# Verify a change

The Stop hook already runs Biome on the changed files, lint, types and unit tests of the
affected packages, the checks of `scripts/` and the hooks, and knip. This skill covers
what it cannot:

1. `bun run lint` (includes architecture boundaries and the web render-only check).
2. `bun run check-types`.
3. `bun run test`.
4. `bun run test:integration` for changes to the database, queues, auth, emails or any
   service code. It starts the full Docker profile first.
5. `bun run test:e2e` for user-facing flows (web or mobile). It builds the services and
   starts them fresh (Docker's full profile must be up), so stop any running stack first.
6. If you changed a contract or schema: `bun run gen`, then confirm `git status` shows
   the regenerated files and they are part of the change.

Report results honestly: list what ran, what passed, and paste the failing output for
anything that failed. Do not claim success for a step you did not run.
