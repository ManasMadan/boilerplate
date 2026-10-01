# Testing

| Layer | Where | Command | Needs |
|---|---|---|---|
| Unit | `src/**/*.test.ts(x)` in each package, `apps/mobile/src`, `apps/ai/tests` (not marked `integration`) | `bun run test` | nothing (cached by turbo) |
| Integration | `test/` in each service, `packages/db/test`, `packages/nest-common/test`, `apps/web/test` (in Chromium), `apps/ai` tests marked `integration` | `bun run test:integration` | the core: Postgres, Valkey, Mailpit (started for you) |
| Integration, file uploads | the suites tagged `files` in `apps/api`, `apps/worker`, `packages/nest-common` and `apps/web/test` | `bun run test:integration:files` | the core plus RustFS and ClamAV (started for you) |
| Coverage | every suite merged, every file at 100% | `bun run test:coverage` | the full profile (`bun run db:up:full`) |
| End to end | `apps/web/e2e`, `apps/mobile/e2e`, then the k6 smoke | `bun run test:e2e` | `bun run db:up:full`, nothing else running on the stack's ports |
| Components | every story in `packages/ui` | `bun run --cwd packages/ui test:stories`, `test:visual` | Chromium; Docker for `test:visual` |
| Load | `load/api.ts` (k6) | `bun run test:load` | a running API, Docker |
| Evals | `apps/ai/evals` | `bun run --cwd apps/ai evals` | nothing with the local stand-ins |
| Restore drill | `scripts/restore-drill.ts` | `bun run db:restore-drill` | the local Postgres container |

Before pushing: `bun run lint`, `bun run check-types`, `bun run test`, and for anything
touching the database, queues or HTTP, `bun run test:integration`. The pre-push hook
(`.husky/pre-push`) runs types and unit tests for the affected packages, the scripts'
and hooks' types and tests, the unit coverage of every line the branch changes
(`bun scripts/unit-coverage.ts --branch`), and knip; the rest is yours to run, and CI
runs it all. The unit coverage check counts scripts/, the hooks, and a package's file
with a unit test beside it that its unit tests otherwise cover completely; a file that
leans on integration tests is left to CI's diff-cover, which merges every suite.

## Unit

Pure tests: no network, no services, so turbo caches them. Vitest in the TypeScript
packages (the `unit` project in services), Jest with React Native Testing Library in
`apps/mobile`, pytest in `apps/ai`.

## Integration

`bun run test:integration` starts the core services (`bun scripts/services.ts up`) and
runs every package's `test:integration`, never cached, except the file-upload tests.
Those need object storage and virus scanning, and are tagged `files` (vitest's
`{ tags: ["files"] }` on their `describe`, declared by `tags` in `packages/vitest-config`):
`bun run test:integration:files` starts the core plus the files services
(`services.ts up --files`) and runs only them. A package's `test:integration` passes
`--tags-filter=!files` and its `test:integration:files` passes `--tags-filter=files`;
`coverage` passes neither, so `bun run test:coverage` and CI's integration job, which
starts every service, run them all. A new test that needs RustFS or ClamAV gets the tag.

What each profile needs: the start adds up the memory limits in `docker-compose.yml` of
what isn't running yet, and refuses unless Docker has that free plus half a gigabyte of
headroom.

| Profile | Starts | Limits add up to | Docker needs free |
|---|---|---|---|
| core (`bun run db:up`, `test:integration`) | Postgres, Valkey, Mailpit | 0.9 GB | about 1.4 GB |
| files (`services.ts up --files`, `test:integration:files`) | the core, RustFS, ClamAV | 2.9 GB | about 3.4 GB |
| mail (`bun run db:up:mail`) | the core, Stalwart | 1.2 GB | about 1.7 GB |
| full (`bun run db:up:full`, `test:coverage`, `test:e2e`) | all of the above, Jaeger | 3.4 GB | about 3.9 GB |

Docker Desktop's default 2 GB fits the core; for the others raise it in Settings,
Resources. ClamAV is most of the files profile (1.5 GB). The integration run takes longer
than two minutes, so run it in the background when a tool times out commands (an agent's
shell, for one).

- Each test file gets its own Postgres database cloned from a migrated template, and
  connects as the service's own role, so a missing grant or row-level security policy
  fails here (see [database.md](database.md#test-databases)).
- Each suite uses its own Valkey database number, and 0 is the dev stack's. Valkey has
  32 (the `--databases` flag in `docker-compose.yml`, which CI's integration job runs too).
  Taken: the api's files 1 to 5, 7 to 10 and 13 (one per file, `startApi(<n>)`),
  webhooks 11, nest-common 12, notifications 14, worker 15, webhooks' Stalwart suite 16,
  the api's breached-password suite 17, the web's browser tests 18, jobs 19 and Python 6.
  A new suite takes the next free number, 20 onwards;
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
- Nothing sleeps for a fixed time. A test waits for what it's waiting on:
  `eventually(read, done)` from `@repo/testing/eventually`, `vi.waitFor` or
  `expect.poll`. To show that something did not happen, it first waits for a signal that
  the work is over (the job completed, the delivery row written, Redis counting the
  subscriber), then checks once. A delay stays only where it stands in for slow work on
  purpose, with a comment saying so.

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

## Web

`apps/web` has two kinds of vitest test, both counted in coverage:

- **Server side** (`src/**/*.test.ts(x)`, the `unit` project, in Node): helpers, the
  proxy, route handlers and route files, and server components. `test/next-server.ts`
  stands in for the request Next.js would be rendering: set `request.cookies` and
  `request.headers`, and next-intl's server functions read them through the real
  `src/i18n/request.ts`. `renderHtml(await Page())` renders a server component,
  async children included. Part of `bun run test`.
- **In the browser** (`test/**/*.test.tsx`, in Chromium through vitest's browser mode):
  pages and components, rendered with `renderPage(<Page />, { url })` from
  `test/render.tsx` inside the app's real providers, and driven like a user with
  `userEvent` and `page` locators from `vitest/browser`. They call the real API: the
  global setup builds apps/api and runs it twice, once with every optional feature on
  (billing against the fake Stripe, files on RustFS, a stand-in for the AI service in
  `test/fake-ai.ts`, Google sign-in) and once with them all off except captcha, where
  Turnstile's script is a stand-in (`test/commands.ts`) and tokens are checked with
  Cloudflare's always-pass test secret. Files named `*.features-off.test.tsx` run against
  the second. The test pages are served on the origin the API knows as `WEB_URL`, and
  `/rpc` and `/api` are proxied to it, so cookies, CORS and passkeys work as on the site.
  Part of `bun run test:integration`.

What a page can't do itself is a command (`commands.<name>()` from `vitest/browser`,
defined in `test/commands.ts`, run in Node): read the code the API queued for an email
(`takeNotification`), set data up with SQL, add a virtual passkey authenticator, compute
an authenticator code. Accounts come from `test/users.ts` (`signUp()` signs a new,
verified user in on the page). Next.js's router exists only inside a Next server, so
`renderPage` provides a stand-in: `router.push` and `<Link>` change the page's URL
(`currentUrl()`), and leaving the page's path unmounts it, as in the app. Full-page
navigations (`window.location.assign`, a redirect to Stripe or Google) are answered
"204 No Content" so the test page stays, and `commands.hardNavigations()` lists them.

Only the API runs, so what the other services would do is done by the test: the
worker's realtime messages (`publishRealtime`), the notification service's in-app rows
(SQL), a Stripe webhook's effect on the subscription (SQL; the fake Stripe's test hooks
make invoices in any status). Uploads go to the real RustFS, sent from Node because its
bucket allows only the dev site's origin (`storageCors`).

Each test starts signed out, with a client IP of its own (the API's auth rate limits
are per IP), and nothing left on screen from the test before it (toasts included).

## Not tested automatically

What CI can't check, and how each is covered instead. A test that needs credentials is
still written, and skips with the reason when they're missing.

| What | Why not in CI | Test, and how to run it |
|---|---|---|
| Google sign-in | needs a real Google account | `apps/web/e2e/google.spec.ts`, with `E2E_GOOGLE_EMAIL` and `E2E_GOOGLE_PASSWORD` |
| Client ID Metadata Documents from a public URL | needs an HTTPS document on the internet | `apps/api/test/oauth.integration.test.ts` (the CIMD case), with `E2E_CIMD_CLIENT_ID` |
| Mail through Stalwart | needs the `mail` profile | `apps/notifications/test/stalwart.integration.test.ts` and `apps/webhooks/test/stalwart.integration.test.ts`, with `STALWART_SMTP_URL` and `STALWART_URL` (above) |
| Native mobile: a session surviving a restart, the push permission prompt, links opened by the OS | needs a device or simulator with a development build | `apps/mobile/maestro/*.yaml`, by hand (`apps/mobile/maestro/README.md`) |
| Real Stripe test mode | the suites use `packages/fake-stripe` | weekly, the calls the api makes against Stripe's test mode and the fake alike (`packages/fake-stripe/src/contract.test.ts`, `stripe.yml`, with `STRIPE_CONTRACT_SECRET_KEY`); hosted Checkout and webhooks by hand: [files-and-billing.md](files-and-billing.md), "Real Stripe test mode" |
| A web push notification being clicked | the service worker's `notificationclick` needs a real browser notification | by hand: allow notifications on the web app, trigger one, click it |
| Email in real mail clients | rendering differs per client | by hand: the previews (`bun run --cwd packages/email dev`), then a real send |
| Real MCP clients | needs Claude or an IDE on the other end | by hand: connect one to `<site>/api/mcp` and `<site>/ai/mcp` |
| Valkey failing over (`valkey.replication`) | needs nodes to lose; kind has one | the chart's tests render it and the start-up scripts' tests (`scripts/valkey-replication.test.ts`) cover which node follows which; on a three-node cluster, once: delete the primary's pod, and the site keeps working within seconds |
| DNS on a name server of your own (`dns.provider = "rfc2136"`) | needs a real name server and zone | OpenTofu's tests (mocked) and the issuer's chart tests; for real, the first certificate after switching (`kubectl get certificate -A`) and `dig` of the site |
| A preview's address posted by Argo CD | needs the preview cluster and the GitHub App | `scripts/previews.test.ts` reads the trigger and template; for real, label a pull request and wait for the comment |
| The weekly backup drill (`postgres.drill`) | needs a cluster with backups; kind has none | `scripts/backup-drill.test.ts` (the script, against a stand-in kubectl) and the chart's tests; for real, its first Sunday in staging, or `kubectl create job --from=cronjob/<release>-restore-drill` |
| CI's own steps: the image smoke test, the caches, the egress allowlists | need GitHub's runners | `scripts/workflows.test.ts` and actionlint; for real, the first pull request after a change to them |
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
  branches included, in `apps/ai/pyproject.toml`). Bun's report counts only for
  `scripts/` and `.claude/hooks/`: it counts lines v8 doesn't, so its view of a package
  file a script imports would show lines as missed that the package's own suite ran.
- A NestJS package's `vitest.config.ts` also adds `decoratorMetadata()` from
  `packages/vitest-config`: the compiler turns every injected constructor parameter into
  a branch that exists in no source line (a guard for import cycles), and this compiles
  it away so coverage counts only the code that was written.
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

In CI a failed test is retried up to twice, to tell a flaky one from a broken one, but a
test that only passed on a retry still fails the run (`failOnFlakyTests`): fix it rather
than rerunning the job.

```sh
bun run test:e2e                                    # everything
bun run test:e2e --app web e2e/assistant.spec.ts    # one app; the rest goes to Playwright
bun run test:e2e --app mobile                       # the mobile screens, rendered for the web
bun run test:e2e --app load                         # the k6 smoke on its own
bun run --cwd apps/web test:e2e                     # against a stack you're already running (bun dev)
```

`apps/web/e2e/google.spec.ts` runs only with `E2E_GOOGLE_EMAIL` and `E2E_GOOGLE_PASSWORD`.
CI runs the suite with the captcha on, with Cloudflare's always-pass test keys (in
`ci.yml`'s e2e job), so the widget and the token check run too; locally
`apps/web/e2e/captcha.spec.ts` skips unless you set them (`.env.example`).

## Mobile

- `bun run --cwd apps/mobile test`: Jest. Screen tests (`src/screens-tests/`) open the
  whole app at a URL with `openApp` (`test/app.ts`, on expo-router's `renderRouter`), so
  routing, the protected routes and the real auth and API clients all run. The network is
  faked at `fetch` with `fakeApi` (`test/fake-api.ts`), which answers each path the way
  the API does; only native modules without a JavaScript stand-in (secure storage, push,
  the build's manifest) are mocked, in `jest.setup.ts`.
- `bun run test:e2e --app mobile`: the app's screens rendered with react-native-web and
  driven by Playwright (`apps/mobile/e2e`), against the API on the mobile web build's own
  origin.
- Maestro flows for what only a native build can check, run by hand
  (`apps/mobile/maestro/README.md`).

## API client

`packages/client`'s hooks are unit tests against the API's contract implemented in
memory (`packages/client/test/stand-in.tsx`): `standIn` takes the procedures a test
calls, typed by the contract, and answers over oRPC's own wire format through the
client's `fetch` option, so inputs and outputs are validated both ways as against the
real API. `renderHook` renders a hook inside `ApiProvider` with `react-test-renderer`.
Polling and reconnect waits run on fake timers (`setInterval` for polling, `setTimeout`
for reconnects and retries), advanced to the millisecond, with `until` to wait for a
condition without moving them. The API's own behaviour is covered by its tests in
`apps/api`.

## Components

`bun run --cwd packages/ui test:stories` runs every story in Chromium, in the light and
dark themes: it must render, pass its play function and have no axe violations. The same
run includes the package's plain browser tests (`src/components/<name>.test.tsx`,
rendered with `render` from `packages/ui/test/render.tsx`) for what a story doesn't show:
a part no story uses, an edge case. They take no screenshots, so they need no baselines.
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
| `bun run lint` | Biome, `lint:boundaries` (dependency-cruiser, the web render-only check and `scripts/check-layers.ts`), `lint:unused`, `lint:markers`, `lint:patterns`, `lint:suppressions`, and each package's `lint` (ruff for Python), all of them even when one fails, with a summary at the end (`scripts/lint.ts`); CI runs the same command |
| `bun run lint:unused` | knip (`knip.jsonc`): unused files, exports and dependencies, and dependencies used but not declared |
| `bun run lint:markers` | no `ponytail:` markers in tracked source (`scripts/check-markers.ts`): a comment says why in plain words |
| `bun run lint:patterns` | code shapes Biome can't see (`scripts/check-patterns.ts`): in services' and packages' `src/`, parsed JSON cast to a type, a type argument on `$queryRaw`, an optional chain three deep, a role compared with `"member"`, an error sent without `sendError`; in tests, a fixed sleep outside a polling loop |
| `bun run check-types` | tsc everywhere, basedpyright (strict) for Python |
| `bun run db:lint` | Squawk on new migrations |
| `bun run --cwd apps/web budget` | first-load JavaScript per route, after `next build` |
| `bun run charts:check` | the Helm charts: lint, unit tests, every environment rendered and validated |
| `bun run infra:check` | OpenTofu fmt, validate and module tests (mocked providers) |

## What CI runs

On every pull request, push to `master` and merge group (`.github/workflows/ci.yml`).
Branch protection requires **CI passed**, which succeeds only when all of these do. On a
pull request, the first job (`scripts/changes.ts`) says which areas it touches (the app,
the charts, OpenTofu, the Dockerfiles, the scripts), and a job for an area it doesn't
touch is skipped: a docs-only change runs only lint and the title check, and a change
to `deploy/` only the charts and the scripts' tests. **CI passed** accepts a skip only
for those areas.

| Job | Runs |
|---|---|
| Lint and boundaries | `bun run lint` (Biome, boundaries, knip, markers, each package's lint) |
| Type-check | `bun run check-types`, then `bun run type-coverage` (no `any` in any workspace's source) |
| Unit tests | `bun run test` |
| Components | the stories with coverage, `test:visual` |
| Integration tests | migrations, the drift check, then every package's `coverage` except Python's and the stories', and the scripts' and hooks' |
| End-to-end tests | `bun run test:e2e`, the bundle budget, the restore drill |
| Python service | ruff, basedpyright, pytest, the evals with stand-ins, then every test with coverage |
| Coverage | the reports of the three jobs above merged: `bun scripts/coverage.ts`, then diff-cover at 100% against the base branch (pull requests) |
| Generated code is committed | `bun run gen`, then no diff |
| API compatibility | oasdiff against the base branch's `apps/api/openapi.json` and `apps/ai/openapi.json`, and the event catalog's compatibility (pull requests) |
| Pull request title | Conventional Commits with an allowed scope (pull requests) |
| Migration safety | `bun run db:lint` |
| Helm charts and GitOps | `bun run charts:check` |
| OpenTofu | `bun run infra:check` |
| Container images | every image builds, Trivy finds no fixable critical or high vulnerability, and each one starts against Postgres and Valkey and answers (`scripts/image-smoke.ts`: the dependencies check, an RPC, a page; the migrate image migrates an empty database) |

Elsewhere: `kind.yml` deploys the stack to a kind cluster, waits for KEDA to read the
worker's queues from Valkey, and smoke-tests the routes (`bun run k8s:up`) when the images, charts or migrations change; `security.yml` runs
CodeQL, a secret scan of the history, dependency review, OSV and a Trivy scan of the
infrastructure configuration.

## Nightly and weekly

| When (UTC) | What |
|---|---|
| 02:43 daily | `kind.yml`: the kind deploy and smoke test |
| 03:23 daily | `ci.yml` on `master`, with the load test at `PROFILE=load` (`LOAD_TARGET_RPS`, default 50) instead of the smoke, and the evals against `EVAL_MODEL` when that variable is set |
| 04:30 daily | Renovate |
| 04:17 Mondays | `security.yml`, for vulnerabilities published against unchanged code |
| 05:41 Wednesdays | `stripe.yml`: the fake Stripe's contract against Stripe's test mode, when `STRIPE_CONTRACT_SECRET_KEY` is set |
