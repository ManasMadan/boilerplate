# Testing

| Layer | Where | Command | Needs |
|---|---|---|---|
| Unit | `src/**/*.test.ts(x)` in each package, `apps/mobile/src`, `apps/ai/tests` (not marked `integration`) | `bun run test` | nothing (cached by turbo) |
| Integration | `test/` in each service, `packages/db/test`, `packages/nest-common/test`, `apps/ai` tests marked `integration` | `bun run test:integration` | Postgres, Valkey, Mailpit, RustFS, ClamAV, Stalwart (started for you) |
| Coverage | every suite merged, every file at 100% | `bun run test:coverage` | the same services |
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
--full`) and runs every package's `test:integration`, never cached. The full profile's
memory limits add up to about 3.4 GB, and the start refuses unless Docker has that free
plus half a gigabyte of headroom (about 3.9 GB): on Docker Desktop's default 2 GB, raise
it in Settings, Resources. It takes longer than two minutes, so run it in the
background when a tool times out commands (an agent's shell, for one).

- Each test file gets its own Postgres database cloned from a migrated template, and
  connects as the service's own role, so a missing grant or row-level security policy
  fails here (see [database.md](database.md#test-databases)).
- Each suite uses its own Valkey database number, and 0 is the dev stack's. Valkey has
  32 (the `--databases` flag in `docker-compose.yml`, which CI's integration job runs too).
  Taken: the api's files 1 to 5, 7 to 10 and 13 (one per file, `startApi(<n>)`),
  webhooks 11, nest-common 12, notifications 14, worker 15, webhooks' Stalwart suite 16
  and Python 6. A new suite takes the next free number, 17 onwards;
  `scripts/redis-databases.test.ts` fails when two suites that flush share one. A change
  to the flag needs the local container recreated (`docker compose up -d valkey`).
- Tests never read your `.env`: they run with `.env.example`'s values (the ports docker
  compose publishes), its placeholder secrets replaced by fresh ones and its empty
  values left unset, so they behave the same on every machine and in CI. Anything
  already set in the environment wins, which is how CI points them at its own services
  (`packages/testing/src/environment.ts`, applied by each package's `vitest.config.ts`,
  and `apps/ai/tests/__init__.py` for Python). A test that needs a feature turns it on
  itself.
- Services are built in-process (`createApiServer()` and the like); emails are read
  back from Mailpit, push and Twilio go to local fakes (`apps/notifications/test`), and
  Stripe to `packages/fake-stripe`.

A few tests need real third parties and are skipped without them
(`E2E_CIMD_CLIENT_ID`, see [environment.md](environment.md#tests-and-tooling)).

The real mail path runs against the Stalwart container (`bun run db:up:mail`) and is
skipped unless its variables are set (see `.env.example`): with `STALWART_SMTP_URL`,
`apps/notifications/test/stalwart.integration.test.ts` submits through it with the
service's own transport; with `STALWART_URL`, `apps/webhooks/test/stalwart.integration.test.ts`
registers a webhook pointing at itself, sends one message that is delivered (to
Mailpit, DKIM-signed) and one to `bounce.test` that is refused, and checks the signed
`delivery.dsn-perm-fail` Stalwart posts becomes the feedback event that suppresses the
address.

## Not tested automatically

What CI can't check, and how each is covered instead. A test that needs credentials is
still written, and skips with the reason when they're missing.

| What | Why not in CI | Test, and how to run it |
|---|---|---|
| Google sign-in | needs a real Google account | `apps/web/e2e/google.spec.ts`, with `E2E_GOOGLE_EMAIL` and `E2E_GOOGLE_PASSWORD` |
| Client ID Metadata Documents from a public URL | needs an HTTPS document on the internet | `apps/api/test/oauth.integration.test.ts` (the CIMD case), with `E2E_CIMD_CLIENT_ID` |
| Turnstile's real widget | CI runs without the Turnstile keys | `apps/web/e2e/captcha.spec.ts` and `apps/api/test/captcha.integration.test.ts`, with Cloudflare's always-pass test keys (`.env.example`) |
| Mail through Stalwart | needs the `mail` profile | `apps/notifications/test/stalwart.integration.test.ts` and `apps/webhooks/test/stalwart.integration.test.ts`, with `STALWART_SMTP_URL` and `STALWART_URL` (above) |
| Native mobile: a session surviving a restart, the push permission prompt, links opened by the OS | needs a device or simulator with a development build | `apps/mobile/maestro/*.yaml`, by hand (`apps/mobile/maestro/README.md`) |
| Real Stripe test mode | the suites use `packages/fake-stripe` | by hand: [files-and-billing.md](files-and-billing.md), "Real Stripe test mode" |
| A web push notification being clicked | the service worker's `notificationclick` needs a real browser notification | by hand: allow notifications on the web app, trigger one, click it |
| Email in real mail clients | rendering differs per client | by hand: the previews (`bun run --cwd packages/email dev`), then a real send |
| Real MCP clients | needs Claude or an IDE on the other end | by hand: connect one to `<site>/api/mcp` and `<site>/ai/mcp` |
| The first real deploy: DNS, TLS, mail deliverability, backups to a new cluster, the SOPS plugin in Argo CD, the first EAS build and store submission, Renovate's and the preview's first runs | needs the real environment | once, per [new-project.md](new-project.md), "The first deploy" |

## Coverage

Every source file is at 100%: lines, branches and functions, in every language. There
are no per-package floors to negotiate: `bun run test:coverage` runs every suite with
coverage and then `bun scripts/coverage.ts`, which merges their reports and fails on any
file below 100%, or one no test loads.

- Every suite writes LCOV: each vitest package (`coverage()` in `packages/vitest-config`
  reports every workspace file its tests load, so a shared package gets credit from the
  apps that exercise it), mobile's jest (`src/**`), bun for `scripts/` and
  `.claude/hooks/` (`bunfig.toml`), and the Python service (`fail_under = 100`,
  branches included, in `apps/ai/pyproject.toml`).
- The merged report is `coverage/merged.lcov`. CI runs diff-cover on it against the base
  branch at 100%, so a pull request can't add or change a line without covering it.
- A file may be below 100% only if the table below lists it, with the reason and the
  test that covers its behaviour another way. The same goes for skipped tests and for
  lint or type suppressions (`biome-ignore`, `@ts-expect-error`, `# pyright: ignore`,
  `# noqa`, coverage pragmas): `bun scripts/suppressions.ts`, part of `bun run lint`,
  fails on any in a file these tables don't list, and a Claude Code hook refuses a new
  one as it's written. Listing a file here is a decision for review, never a way round.

## Coverage exceptions

| File | Why it can't be covered | What proves it instead |
|---|---|---|

## Skipped tests

| File | Skipped when | Where it runs |
|---|---|---|
| `apps/api/test/oauth.integration.test.ts` | `E2E_CIMD_CLIENT_ID` is unset: the client metadata document must be served over public HTTPS | by hand, against a deployed environment |
| `apps/notifications/test/stalwart.integration.test.ts` | `SMTP_URL` (Stalwart) is unset: Stalwart isn't in the default profile | CI's integration job, with the `mail` profile |
| `apps/webhooks/test/stalwart.integration.test.ts` | `STALWART_URL` is unset, as above | CI's integration job, with the `mail` profile |
| `apps/web/e2e/captcha.spec.ts` | the real Turnstile keys are unset (the test keys always pass) | by hand, with real keys |
| `apps/web/e2e/google.spec.ts` | `E2E_GOOGLE_EMAIL` and `E2E_GOOGLE_PASSWORD` are unset | by hand, with a test Google account |

## Suppressions

| File | Suppression | Why |
|---|---|---|
| `apps/web/src/lib/cookies.ts` | `biome-ignore lint/suspicious/noDocumentCookie` | the Cookie Store API isn't in every browser yet |
| `apps/ai/app/embeddings.py` | `# noqa: SIM905` | a stop-word list reads as prose on one line |
| `apps/ai/app/documents.py` | `# pyright: ignore[reportMissingTypeStubs]` | langgraph ships no stubs |
| `apps/ai/app/summaries.py` | `# pyright: ignore[reportMissingTypeStubs, reportUnknownMemberType]` | langgraph ships no stubs, and its graph, config and checkpointer types are unknown |
| `apps/ai/app/queues.py` | `# pyright: ignore[reportMissingTypeStubs, reportUnknownMemberType, reportArgumentType]` | bullmq ships no stubs and leaves job data untyped |
| `apps/ai/app/main.py` | `# pyright: ignore[reportUnknownMemberType]` | redis-py's options are untyped |
| `apps/ai/app/worker.py` | `# pyright: ignore[reportUnknownMemberType]` | redis-py's options are untyped |
| `apps/ai/app/realtime.py` | `# pyright: ignore[reportUnknownMemberType]` | redis-py's options are untyped |
| `apps/ai/app/settings.py` | `# pyright: ignore[reportCallIssue]` | pydantic-settings fills the fields from the environment |
| `apps/ai/app/telemetry.py` | `# pyright: ignore[reportUnknownMemberType]` | the Redis instrumentor's `instrument()` is untyped |
| `apps/ai/evals/__main__.py` | `# pyright: ignore[reportAssignmentType]` | pydantic-evals' report type is wider than what it returns |
| `apps/ai/tests/conftest.py` | `# pyright: ignore[reportUnknownMemberType]` | redis-py's options are untyped |
| `apps/ai/tests/support.py` | `# pyright: ignore[reportUnknownMemberType]` | redis-py's options and handlers are untyped |
| `apps/ai/tests/test_evals.py` | `# pyright: ignore[reportArgumentType]` | these checks never read spans, so none are passed |

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
| `bun run lint` | Biome, `lint:boundaries` (dependency-cruiser and the web render-only check), `lint:unused`, `lint:markers`, and each package's `lint` (ruff for Python) |
| `bun run lint:unused` | knip (`knip.jsonc`): unused files, exports and dependencies, and dependencies used but not declared |
| `bun run lint:markers` | no `ponytail:` markers in tracked source (`scripts/check-markers.ts`): a comment says why in plain words |
| `bun run check-types` | tsc everywhere, basedpyright (strict) for Python |
| `bun run db:lint` | Squawk on new migrations |
| `bun run --cwd apps/web budget` | first-load JavaScript per route, after `next build` |
| `bun run charts:check` | the Helm charts: lint, unit tests, every environment rendered and validated |
| `bun run infra:check` | OpenTofu fmt, validate and module tests (mocked providers) |

## What CI runs

On every pull request, push to `master` and merge group (`.github/workflows/ci.yml`).
Branch protection requires **CI passed**, which succeeds only when all of these do:

| Job | Runs |
|---|---|
| Lint and boundaries | `biome ci`, `lint:boundaries`, `lint:unused` |
| Type-check | `bun run check-types` |
| Unit tests | `bun run test` |
| Components | the stories with coverage, `test:visual` |
| Integration tests | migrations, the drift check, then every package's `coverage` except Python's and the stories', and the scripts' and hooks' |
| End-to-end tests | `bun run test:e2e`, the bundle budget, the restore drill |
| Python service | ruff, basedpyright, pytest, the evals with stand-ins, then every test with coverage |
| Coverage | the reports of the three jobs above merged: `bun scripts/coverage.ts`, then diff-cover at 100% against the base branch (pull requests) |
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
