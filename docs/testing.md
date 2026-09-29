# Testing

| Layer | Where | Command | Needs |
|---|---|---|---|
| Unit | `src/**/*.test.ts(x)` in each package, `apps/mobile/src`, `apps/ai/tests` (not marked `integration`) | `bun run test` | nothing (cached by turbo) |
| Integration | `test/` in each service, `packages/db/test`, `packages/nest-common/test`, `apps/ai` tests marked `integration` | `bun run test:integration` | Postgres, Valkey, Mailpit, RustFS, ClamAV (started for you) |
| Coverage | unit and integration together, against each package's floor | `bun run test:coverage` | the same services |
| End to end | `apps/web/e2e`, `apps/mobile/e2e`, then the k6 smoke | `bun run test:e2e` | `bun run db:up:full`, nothing else running on the stack's ports |
| Components | every story in `packages/ui` | `bun run --cwd packages/ui test:stories`, `test:visual` | Chromium; Docker for `test:visual` |
| Load | `load/api.ts` (k6) | `bun run test:load` | a running API, Docker |
| Evals | `apps/ai/evals` | `bun run --cwd apps/ai evals` | nothing with the local stand-ins |
| Restore drill | `scripts/restore-drill.ts` | `bun run db:restore-drill` | the local Postgres container |

Before pushing: `bun run lint`, `bun run check-types`, `bun run test`, and for anything
touching the database, queues or HTTP, `bun run test:integration`.

## Unit

Pure tests: no network, no services, so turbo caches them. Vitest in the TypeScript
packages (the `unit` project in services), Jest with React Native Testing Library in
`apps/mobile`, pytest in `apps/ai`.

## Integration

`bun run test:integration` starts the full Docker profile (`bun scripts/services.ts up
--full`) and runs every package's `test:integration`, never cached.

- Each test file gets its own Postgres database cloned from a migrated template, and
  connects as the service's own role, so a missing grant or row-level security policy
  fails here (see [database.md](database.md#test-databases)).
- Each suite uses its own Redis database number (the TypeScript suites 7 to 15, Python 6;
  0 is the dev stack).
- Services are built in-process (`createApiServer()` and the like); emails are read
  back from Mailpit, push and Twilio go to local fakes (`apps/notifications/test`), and
  Stripe to `packages/fake-stripe`.

A few tests need real third parties and are skipped without them
(`E2E_CIMD_CLIENT_ID`, see [environment.md](environment.md#tests-and-tooling)).

## Coverage floors

`bun run test:coverage` runs unit and integration tests with thresholds, and fails below
them:

- TypeScript: each package passes its floor to `coverage()` from `packages/vitest-config`
  in its `vitest.config.ts` (lines, functions, branches, statements).
- Mobile: `coverageThreshold` in `apps/mobile/jest.config.js` (over `src/lib`).
- Python: `fail_under = 95` in `apps/ai/pyproject.toml`.

Each floor is what the suite meets, rounded down, less a point. Raise it as tests are
added; lowering it needs a reason in review.

## End to end

`bun run test:e2e` (`scripts/e2e.ts`) tests exactly what it just built:

1. builds api, worker, notifications, webhooks and web for production, and the mobile
   app for the web;
2. starts the fake Stripe, those services, the AI service and its worker, the web app and
   the mobile web build, all with `NODE_ENV=test` (production refuses the local stand-ins
   the suite uses), logging to `logs/`;
3. runs the web Playwright suite, the mobile one, then the k6 smoke;
4. stops everything.

It refuses to start while something already listens on the stack's ports, so an old
server can't answer instead.

```sh
bun run test:e2e                                    # everything
bun run test:e2e --app web e2e/assistant.spec.ts    # one app; the rest goes to Playwright
bun run test:e2e --app mobile                       # the mobile screens, rendered for the web
bun run test:e2e --app load                         # the k6 smoke on its own
bun run --cwd apps/web test:e2e                     # against a stack you're already running (bun dev)
```

`apps/web/e2e/google.spec.ts` runs only with `E2E_GOOGLE_EMAIL` and `E2E_GOOGLE_PASSWORD`.

## Mobile

- `bun run --cwd apps/mobile test`: Jest.
- `bun run test:e2e --app mobile`: the app's screens rendered with react-native-web and
  driven by Playwright (`apps/mobile/e2e`), against the API on the mobile web build's own
  origin.
- Maestro flows for what only a native build can check, run by hand
  (`apps/mobile/maestro/README.md`).

## Components

`bun run --cwd packages/ui test:stories` runs every story in Chromium, in the light and
dark themes: it must render, pass its play function and have no axe violations.
`bun run --cwd packages/ui test:visual` compares a screenshot of every story and theme
with the committed baselines, in the Playwright Docker image;
`test:visual:update` rewrites them.

## Load

```sh
bun run test:load                                # smoke: a few requests a second for 30 s
PROFILE=load bun run test:load                   # ramps to TARGET_RPS (default 200) and holds it
PROFILE=load DURATION=30m bun run test:load      # soak
```

It signs in `LOAD_USERS` users first through the API's own auth
(`bun run --cwd apps/api load:users`, sessions in `load/.sessions.json`, since sign-in is
rate limited per IP), then runs k6 in Docker against `BASE_URL` (default
`http://host.docker.internal:3001`). The traffic is signed-in users reading and changing
todos over `/api/v1`, which exercises the session, membership, row-level security,
optimistic versions and the outbox. The thresholds in `load/api.ts` are the latency and
error budget; the run fails when one does.

## Python

`bun run test` and `bun run test:integration` include `apps/ai`. The integration tests run
the worker as a subprocess and check the SQLAlchemy models against the migrated database.
The evals run on every change with the local stand-ins; see
[python-services.md](python-services.md#evals).

## Static checks

| Command | What it checks |
|---|---|
| `bun run lint` | Biome, `lint:boundaries` (dependency-cruiser and the web render-only check), `lint:unused`, and each package's `lint` (ruff for Python) |
| `bun run lint:unused` | knip (`knip.jsonc`): unused files, exports and dependencies, and dependencies used but not declared |
| `bun run check-types` | tsc everywhere, basedpyright (strict) for Python |
| `bun run db:lint` | Squawk on new migrations |
| `bun run --cwd apps/web budget` | first-load JavaScript per route, after `next build` |
| `bun run charts:check` | the Helm charts: lint, unit tests, every environment rendered and validated |
| `bun run infra:check` | OpenTofu fmt, validate and module tests (mocked clouds) |

## What CI runs

On every pull request, push to `master` and merge group (`.github/workflows/ci.yml`).
Branch protection requires **CI passed**, which succeeds only when all of these do:

| Job | Runs |
|---|---|
| Lint and boundaries | `biome ci`, `lint:boundaries`, `lint:unused` |
| Type-check | `bun run check-types` |
| Unit tests | `bun run test` |
| Components | `test:stories`, `test:visual` |
| Integration tests | migrations, the drift check, then every package's `coverage` except Python's |
| End-to-end tests | `bun run test:e2e`, the bundle budget, the restore drill |
| Python service | ruff, basedpyright, pytest, the evals with stand-ins, then every test with coverage |
| Generated code is committed | `bun run gen`, then no diff |
| API compatibility | oasdiff against the base branch's `apps/api/openapi.json` (pull requests) |
| Pull request title | Conventional Commits with an allowed scope (pull requests) |
| Migration safety | `bun run db:lint` |
| Helm charts and GitOps | `bun run charts:check` |
| OpenTofu | `bun run infra:check` |
| Container images | every image builds, and Trivy finds no fixable critical or high vulnerability |

Elsewhere: `kind.yml` deploys the stack to a kind cluster and smoke-tests the routes
(`bun run k8s:up`) when the images, charts or migrations change; `security.yml` runs
CodeQL, a secret scan of the history, dependency review, OSV and a Trivy scan of the
infrastructure configuration.

## Nightly and weekly

| When (UTC) | What |
|---|---|
| 02:43 daily | `kind.yml`: the kind deploy and smoke test |
| 03:23 daily | `ci.yml` on `master`, with the load test at `PROFILE=load` (`LOAD_TARGET_RPS`, default 50) instead of the smoke, and the evals against `EVAL_MODEL` when that variable is set |
| 04:30 daily | Renovate |
| 04:17 Mondays | `security.yml`, for vulnerabilities published against unchanged code |
