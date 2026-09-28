---
name: setup
description: Set up this repo on a new machine or repair a broken local environment. Use when the user asks to install, set up, bootstrap or "get it running", when `bun run doctor` reports problems, or when commands fail because of missing tools, .env variables or local services.
---

# Setup

1. Run `bun run doctor` and read every line.
2. Fix tool problems first; they need the user:
   - Node version mismatch → ask the user to run `nvm install && nvm use` (reads `.nvmrc`).
   - Docker not running → ask the user to start Docker Desktop.
   - `uv` missing → only needed for `apps/ai`; suggest `brew install uv`.
3. Run `bun run setup`. It is idempotent: creates `.env` with generated secrets, installs
   dependencies, starts core services, applies migrations and generates code.
4. Run `bun run doctor` again and confirm "All good".

Never read or print `.env`. To set a value the user gives you, run
`bun run env:set KEY=value`. If a variable is missing from `.env`, it is also missing
from `.env.example`; add it there and in the service's `src/env.ts`.

If a port is taken, set the matching `*_PORT` variable (see `.env.example`) with
`bun run env:set`, update the URL that uses it, then `bun run db:up`.
