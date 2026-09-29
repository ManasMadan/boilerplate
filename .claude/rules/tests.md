---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/test/**"
  - "**/e2e/**"
  - "apps/ai/tests/**"
  - "packages/vitest-config/**"
  - "packages/fake-stripe/**"
---

# Tests

Which kind goes where:

| Kind | Location | Runs with | Needs |
|---|---|---|---|
| Unit | `src/**/*.test.ts` next to the code (Jest in `apps/mobile`) | `bun run test` (cached, Stop hook) | nothing |
| Integration | `<pkg>/test/**/*.test.ts` (apps name them `*.integration.test.ts`) | `bun run test:integration` | Docker (the command starts it) |
| E2E (web) | `apps/web/e2e/*.spec.ts` | `bun run test:e2e --app web` | full stack |
| E2E (mobile) | `apps/mobile/e2e/*.spec.ts` (react-native-web); native flows in `apps/mobile/maestro/` | `bun run test:e2e --app mobile` | full stack |
| Python | `apps/ai/tests/test_*.py`, `pytest.mark.integration` for DB/Redis | `bun run test` / `bun run test:integration` | Docker for integration |
| Components | `packages/ui/src/components/*.stories.tsx` with `play` | `bun run --cwd packages/ui test:stories` | Playwright browser |

- Unit tests are pure: no network, no database, no clock you don't control. They are
  cached by turbo, so a hidden dependency gives stale results.
- Anything that touches Postgres, Valkey, email, auth or HTTP is an integration test
  against the real service. Do not mock Prisma, Redis, BullMQ or the database; a mock
  would hide exactly the RLS, grant and serialization bugs these tests exist for.
- Integration tests connect as the service's own role (`createTestDatabase().urlFor(role)`
  from `@repo/db/testing`), each file on its own cloned database, so a missing grant or
  policy fails here. Build data with `factories(db)`, not raw inserts.
- Third-party providers are replaced by local fakes that speak the real protocol:
  `packages/fake-stripe`, `apps/notifications/test/fake-twilio.ts` and `fake-push.ts`,
  Mailpit for email, the `local:extractive` model and `hashing` embeddings for AI. New
  providers get a fake like these, not `vi.mock`.
- Coverage floors are per package in its `vitest.config.ts` (unit and integration
  counted together). Raise a floor when you add tests; lowering one needs a reason in
  the PR.
- A bug fix starts with a test that fails without the fix.
- Tenancy changes need a test that a second organization cannot see or change the row.
