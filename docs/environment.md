# Environment variables

Every service reads the one root `.env` locally (package scripts load it with
`bun --env-file` or `node --env-file-if-exists`). In Kubernetes each service gets only its
own variables, from the stack chart's values and its `<release>-<service>` Secret (see
`deploy/README.md`).

## How configuration works

- **Validated at boot.** Each Nest service composes its schema in `src/env.ts` from the
  shared fragments in `packages/nest-common/src/env.ts` (`coreEnv`, `databaseEnv`,
  `redisEnv`, `storageEnv`, `requiredInProduction`). The web app validates in
  `apps/web/src/env.ts` at start and at build; the Python service in
  `apps/ai/app/settings.py` on first use. A missing or malformed value stops the process
  with a readable message. Empty strings count as unset.
- **Features switch on when their block is present.** Google sign-in, captcha, files,
  billing and AI are on exactly when their variables are set (`apps/api/src/features.ts`);
  push platforms likewise (`apps/notifications/src/env.ts`). A half-configured feature
  (a Google client id without its secret, two of three FCM values) fails at boot.
  Disabled features answer `FEATURE_DISABLED`, and clients read the same map from
  `system.info` to hide their UI.
- **Production refuses dev stand-ins.** With `NODE_ENV=production` the services refuse
  to start with `STRIPE_API_URL`, `WEBHOOK_ALLOWED_PRIVATE_ADDRESSES`, `FILE_SCANNER=none`
  (with files on), `SMS_PROVIDER=email`, the push and Twilio test hooks,
  `AI_EMBEDDINGS=hashing` or a `local:` model. Variables wrapped in `requiredInProduction`
  have a localhost default in development and are mandatory in production.

## Setting values

`bun run setup` copies `.env.example` to `.env`, adds variables that are missing from an
existing `.env`, and replaces every `change-me` / `replace-me` placeholder with a fresh
secret (`ENCRYPTION_KEYS` as `<yyyy-mm>:<base64>`, a P-256 pair for the VAPID keys, 32
random bytes for the rest). Re-running it keeps existing values.

To set one value without opening `.env`:

```sh
bun run env:set STRIPE_SECRET_KEY=sk_test_...
echo "sk_test_..." | bun run env:set STRIPE_SECRET_KEY   # value from stdin, not argv
```

`bun run doctor` reports `.env` drift against `.env.example`.

A new variable goes in the service's `src/env.ts`, `.env.example` and this file, in the
same change.

In the tables, "req." means the service won't start without it; a default in the second
column applies when it's unset.

## Shared by every Node service

Read by api, worker, notifications and webhooks (`coreEnv`).

| Variable | Default | What it does |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production`. Production turns on the refusals above. |
| `LOG_LEVEL` | `info` | pino level: `fatal` … `trace`, or `silent`. |
| `TRUSTED_PROXIES` | `loopback` | Comma-separated CIDRs or `loopback`, `linklocal`, `uniquelocal`: who may set `X-Forwarded-For` and `x-request-id`. The client IP drives rate limits, lockout and audit logs. The stack chart sets `uniquelocal`. |
| `LOAD_SHEDDING` | `on` | `off` stops answering 503 under pressure. Only for many instances on one machine (the integration tests). |
| `RELEASE` | `dev` | Build id (image tag), stamped by CI. The web app sends it to the API as `x-app-version`. |
| `PORT` | per service | api 3001, worker 3002, notifications 3003, webhooks 3004. |

The AI service reads `NODE_ENV`, `LOG_LEVEL` (`debug`, `info`, `warning` or `error`
there) and `RELEASE` too; it listens on 8000 (its package scripts pass `--port 8000`).

## Database

Each service connects as its own Postgres role (see [database.md](database.md)).
`databaseEnv("API")` gives `API_DATABASE_URL` and `API_DATABASE_POOL_MAX`, and so on.

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `MIGRATOR_DATABASE_URL` | `packages/db` (Prisma CLI, test databases), apps/ai tests | `postgresql://migrator:migrator@localhost:55432/app` | The owner role. Only migrations and test setup use it. |
| `SHADOW_DATABASE_URL` | Prisma CLI | `…/app_shadow` | Scratch database `prisma migrate dev` uses to detect drift. |
| `API_DATABASE_URL` | api (req.) | `postgresql://app_api:app_api@…/app` | |
| `WORKER_DATABASE_URL` | worker (req.) | `postgresql://app_worker:…/app` | |
| `WORKER_DATABASE_DIRECT_URL` | worker (req.) | same as above locally | A non-pooled connection for the outbox relay's `LISTEN`, which a transaction-mode pooler drops. |
| `NOTIFICATIONS_DATABASE_URL` | notifications (req.) | `postgresql://app_notifications:…/app` | |
| `WEBHOOKS_DATABASE_URL` | webhooks (req.) | `postgresql://app_webhooks:…/app` | |
| `AI_DATABASE_URL` | ai (req.) | `postgresql://app_ai:…/app` | |
| `<SERVICE>_DATABASE_POOL_MAX` | each service | 10 (ai: 5) | Connections per process. The sum over all replicas must fit the server's limit. |

## Redis (Valkey)

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `REDIS_URL` | api, worker, notifications, webhooks, ai (req.) | `redis://localhost:56379` | Sessions, cache, rate limits, queues, realtime pub/sub. `redis://` or `rediss://`. |

## Local service ports

Read by `docker-compose.yml` only. Change one if the port is taken, and update the URL
that uses it.

| Variable | Default | Service |
|---|---|---|
| `POSTGRES_PORT` | 55432 | Postgres (pgvector) |
| `VALKEY_PORT` | 56379 | Valkey |
| `MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT` | 51025, 58025 | Mailpit |
| `S3_PORT`, `S3_CONSOLE_PORT` | 59000, 59001 | RustFS (`files` profile) |
| `CLAMAV_PORT` | 53310 | ClamAV (`files` profile) |

## Auth and the API (apps/api)

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | api (req.) | generated | At least 32 characters. Signs sessions and auth tokens. |
| `BETTER_AUTH_URL` | api (req.), ai | `http://localhost:3000` | The site's public origin. The API is served on it (`/rpc`, `/api`), so cookies are first-party; OAuth callbacks, the OAuth issuer and MCP resource URLs are built from it. The AI service needs it (with `API_URL`) for its MCP server. |
| `WEB_URL` | api (req.), web (req.), notifications | `http://localhost:3000` | The web app's origin: the API's CORS and trusted origin, links in messages, canonical URLs. Notifications: required in production. |
| `APP_ORIGINS` | api | `http://localhost:3100` | Other origins allowed to sign users in, comma-separated (the mobile app's web build). Native apps need nothing here. |
| `MINIMUM_CLIENT_VERSION` | api | `0.0.0` | Clients sending an older `x-app-version` get `CLIENT_OUTDATED` (mobile shows its update screen). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | api | empty | Both set: "Sign in with Google" (`google` feature). Redirect URI: `${BETTER_AUTH_URL}/api/auth/callback/google`. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | api | empty | Both set: Cloudflare Turnstile on sign-up, emailed codes and password reset (`captcha` feature). The site key reaches browsers through `system.info`. Cloudflare's always-pass test keys are in `.env.example`. |
| `ENCRYPTION_KEYS` | api (req.), webhooks (req.) | generated | `id:base64key[,id:base64key…]`, 32-byte keys. The first encrypts, any listed key decrypts; prepend a new one to rotate. Encrypts webhook signing secrets at rest. |
| `UNSUBSCRIBE_SECRET` | api (req.), notifications (req.) | generated | At least 32 characters. Notifications signs one-click unsubscribe links, the API checks them. |

## Email (apps/notifications)

| Variable | Default / example | What it does |
|---|---|---|
| `EMAIL_PROVIDER` | `smtp` | `smtp` (Mailpit locally; SES, Postmark, SendGrid…) or `resend`. |
| `SMTP_URL` | `smtp://localhost:51025` | `smtp://` or `smtps://`. Required in production. |
| `RESEND_API_KEY` | empty | `re_…`. Required when `EMAIL_PROVIDER=resend`. |
| `EMAIL_FROM` | `Boilerplate <no-reply@example.com>` | Sender. Required in production. |
| `DIGEST_HOUR` | 8 | Local hour (each user's time zone) from which their daily digest goes out. |
| `NOTIFICATIONS_CRITICAL_CONCURRENCY` | 20 | Jobs per process on `notifications-critical`. |
| `NOTIFICATIONS_BULK_CONCURRENCY` | 5 | Jobs per process on `notifications-bulk`. |
| `MAILPIT_URL` | `http://localhost:58025` | Not read by any service: the tests (web, mobile, Maestro, notifications) read caught emails from it. |

## Texts (apps/notifications)

| Variable | Default / example | What it does |
|---|---|---|
| `SMS_PROVIDER` | `email` outside production, unset in production | `twilio`, or `email` (delivers texts to Mailpit as mail to `<digits>@sms.test`; refused in production). Unset: nothing is texted. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | empty | All three required for `twilio`. `TWILIO_FROM` is an E.164 number or a Messaging Service SID (`MG…`). |
| `TWILIO_API_URL` | unset | Test hook: where Twilio's API lives. Refused in production. |

## Push (apps/notifications; apps/api hands out the VAPID public key)

Each platform is on when all of its variables are set.

| Variable | Default / example | What it does |
|---|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generated by setup | Web Push key pair. The API also reads the public key and returns it from `system.info`. By hand: `bunx web-push generate-vapid-keys`. |
| `VAPID_SUBJECT` | `mailto:dev@example.com` | `mailto:` or `https:` contact for push services. |
| `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | empty | Android: a Firebase service account. |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID` | empty | iOS: an APNs auth key (`.p8`). |
| `APNS_URL` | `https://api.push.apple.com` | `https://api.sandbox.push.apple.com` for development builds. |
| `FCM_TOKEN_URL`, `FCM_API_URL`, `WEB_PUSH_TEST_ORIGIN` | unset | Test hooks (fake push servers). Refused in production. |

## Files (apps/api signs uploads, apps/worker checks them)

On when `S3_BUCKET` is set (`files` feature). Read by api and worker (`storageEnv`).

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `S3_BUCKET` | api, worker | empty (`uploads` locally) | Turns uploads on. |
| `S3_REGION` | api, worker | `us-east-1` | |
| `S3_ENDPOINT` | api, worker | `http://localhost:59000` | Omit on AWS. R2/GCS: their S3 endpoint. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | api, worker | `rustfs`, `rustfs-secret` | Omit on AWS with workload identity. |
| `S3_FORCE_PATH_STYLE` | api, worker | `false` (`.env.example`: `true`) | For RustFS/MinIO-style servers without virtual-hosted buckets. |
| `STORAGE_ORIGIN` | web | `http://localhost:59000` | The storage origin browsers upload to and load from, allowed by the web app's CSP. |
| `FILE_SCANNER` | worker | `clamav` | `none` skips virus scanning: development only (refused in production when files are on). |
| `CLAMAV_URL` | worker | `tcp://localhost:53310` | clamd. |
| `FILES_CONCURRENCY` | worker | 2 | Uploads checked at once per process. |

## Billing (apps/api; apps/webhooks receives Stripe's events)

On when `STRIPE_SECRET_KEY` and both prices are set (`billing` feature); any other
combination fails at boot. See [files-and-billing.md](files-and-billing.md).

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | api, fake Stripe | empty | `sk_test_…`, `sk_live_…` or a restricted `rk_…` key. |
| `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY` | api, fake Stripe | empty | Recurring price ids (`price_…`) for the Pro plan. |
| `STRIPE_TRIAL_DAYS` | api | 14 | Trial on an organization's first subscription; 0 turns trials off. |
| `STRIPE_API_URL` | api | empty | Points the Stripe client at the fake Stripe (`http://127.0.0.1:12111`). Refused in production. |
| `STRIPE_WEBHOOK_SECRET` | webhooks, fake Stripe | empty | `whsec_…`. Without it `/webhooks/stripe` answers 404. |
| `STRIPE_FAKE_PORT` | fake Stripe | 12111 | |
| `STRIPE_FAKE_WEBHOOK_URL` | fake Stripe | `http://localhost:3004/webhooks/stripe` | Where the fake sends its events. |

## Webhooks (apps/webhooks, and apps/api for endpoint settings)

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `WEBHOOK_ALLOWED_PRIVATE_ADDRESSES` | api, webhooks | empty (`127.0.0.1` in `.env.example`) | Exact private IPs customer endpoints may use, for local receivers and tests. Must be empty in production. |
| `WEBHOOK_DELIVERY_CONCURRENCY` | webhooks | 20 | Deliveries in flight per process. |
| `WEBHOOK_TIMEOUT_MS` | webhooks | 15000 | Per delivery attempt, at most 60000. |
| `WEBHOOK_AUTO_DISABLE_HOURS` | webhooks | 120 | An endpoint failing this long without one success is disabled (and its admins notified). |

## Worker (apps/worker)

| Variable | Default | What it does |
|---|---|---|
| `RELAY_BATCH_SIZE` | 100 | Outbox rows claimed per transaction (at most 1000). |
| `RELAY_POLL_INTERVAL_MS` | 1000 | How often the relay looks even without a `NOTIFY`. |
| `AUDIT_CONCURRENCY` | 20 | Audit events written at once per process. |
| `OUTBOX_RETENTION_DAYS` | 7 | Published outbox rows are kept this long: the replay window for new consumers. |
| `PROCESSED_EVENT_RETENTION_DAYS` | 30 | `<schema>.processed_event` retention. |
| `AUDIT_RETENTION_MONTHS` | 13 | Audit log partitions older than this are dropped. |
| `WEBHOOK_HISTORY_DAYS` | 30 | Webhook delivery logs and received provider events. |
| `NOTIFICATION_HISTORY_DAYS` | 90 | Notification delivery log, and in-app notifications read longer ago. |

## AI (apps/ai; apps/api and apps/web call it)

See [python-services.md](python-services.md). The `ai` feature in the API is on when
both `AI_URL` and `AI_SERVICE_SECRET` are set.

| Variable | Read by | Default / example | What it does |
|---|---|---|---|
| `AI_URL` | api, web | `http://localhost:8000` | Where the API calls the AI service. The web app forwards `/ai/mcp` there in local development. |
| `AI_SERVICE_SECRET` | ai (req.), api | generated | At least 32 characters. The API signs a 60-second token for every call with it; the service verifies it. |
| `API_URL` | web, ai, `apps/mobile/scripts/serve-web.ts` | `http://localhost:3001` | Web: where `/rpc`, `/api` and `/docs` are forwarded in local development (the gateway does it when deployed). AI: where its MCP server fetches the API's JWKS. |
| `AI_MODEL` | ai | unset (`local:extractive` in `.env.example`) | A Pydantic AI model name (`anthropic:claude-sonnet-5`, `openai:gpt-5`). Unset: the assistant is off. `local:extractive` quotes the best passage with no model (refused in production). |
| `AI_FALLBACK_MODEL` | ai | unset | Used when the main model fails. |
| `AI_EMBEDDINGS` | ai | `hashing` | An embedding model name (`openai:text-embedding-3-small`) giving 1536 dimensions, or `hashing` (lexical, refused in production). |
| `AI_MIN_RELEVANCE` | ai | 0 | Cosine similarity below which a passage isn't used (provider embeddings; 0 lets the model judge). Calibrate with the evals. |
| `AI_MONTHLY_TOKENS_PER_ORG` | ai | 2000000 | Tokens a workspace may use per calendar month. |
| `AI_TOKENS_PER_RUN` | ai | 20000 | Cap per answer (at least 1000). |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | ai (the Pydantic AI providers, not `settings.py`) | unset | The provider key for the model names above. Not in `.env.example`: add with `bun run env:set`. |

## Web (apps/web)

Server-only: nothing environment-specific is built into the browser bundle.

| Variable | Default | What it does |
|---|---|---|
| `WEB_URL` | required | This site's origin (canonical URLs, sitemap). |
| `API_URL`, `AI_URL`, `STORAGE_ORIGIN` | see above | |
| `RELEASE` | `dev` | Sent to the API as `x-app-version`. |
| `SKIP_ENV_VALIDATION` | unset | `1` only for `next typegen` inside `check-types`. |

## Mobile (apps/mobile)

Read at build time (`app.config.ts`, `src/lib/config.ts`).

| Variable | Default | What it does |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | `http://localhost:3000` | The site's origin; on a phone use your machine's LAN address. EAS builds get it per EAS environment (`bunx eas-cli env:create --environment production --name EXPO_PUBLIC_API_URL --value …`). |
| `EAS_PROJECT_ID` | empty | From `bunx eas-cli init`. Enables over-the-air updates; only EAS builds need it. |
| `APP_VARIANT` | `development` | `development`, `preview` or `production`: app name and identifiers. Set by the profiles in `eas.json`. |

## Tests and tooling

Not read by any service.

| Variable | Read by | What it does |
|---|---|---|
| `E2E_BASE_URL` | web Playwright | Default `http://localhost:3000`. |
| `E2E_MOBILE_URL` | mobile Playwright | Default `http://localhost:3100`. |
| `MOBILE_WEB_PORT` | `apps/mobile/scripts/serve-web.ts` | Default 3100. |
| `E2E_GOOGLE_EMAIL`, `E2E_GOOGLE_PASSWORD` | `apps/web/e2e/google.spec.ts` | A real Google account; the spec is skipped without them. |
| `E2E_CIMD_CLIENT_ID`, `E2E_CIMD_REDIRECT_URI` | `apps/api/test/oauth.integration.test.ts` | A real Client ID Metadata Document; the test is skipped without them. |
| `LOAD_USERS` | `apps/api/src/load-users.ts` | Signed-in users for k6 (default 50, at most 1000). |
| `BASE_URL`, `PROFILE`, `TARGET_RPS`, `DURATION` | `load/api.ts` | k6 target (default `http://host.docker.internal:3001`), `smoke` or `load`, rate (default 200), hold time (default `5m`). |
| `PG_CONTAINER` | `scripts/restore-drill.ts` | Run the drill against another Postgres container (CI). |
| `EVAL_JUDGE_MODEL`, `EVAL_MIN_PASS_RATE` | `apps/ai/evals` | LLM-judged rubrics, and the pass rate below which the run fails (default 1.0). |
