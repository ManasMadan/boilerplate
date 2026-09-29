# Architecture

## Deployables

```mermaid
flowchart LR
  browser[Browser] --> gw
  mobile[Mobile app] --> gw
  mcpc[MCP clients] --> gw
  stripe[Stripe] --> gw

  subgraph cluster[One namespace per environment]
    gw{{Gateway}}
    web[web<br/>Next.js :3000]
    api[api<br/>NestJS :3001]
    webhooks[webhooks<br/>NestJS :3004]
    ai[ai<br/>FastAPI :8000]
    worker[worker<br/>NestJS :3002]
    notifications[notifications<br/>NestJS :3003]
    aiworker[ai-worker<br/>Python]
    pg[(Postgres)]
    valkey[(Valkey)]
  end

  s3[(Object storage)]

  gw -- "/" --> web
  gw -- "/rpc, /api, /docs" --> api
  gw -- "/webhooks" --> webhooks
  gw -- "/ai/mcp" --> ai
  api -- "signed call" --> ai
  api & worker & notifications & webhooks & ai & aiworker --> pg
  api & worker & notifications & webhooks & ai & aiworker --> valkey
  browser -. "presigned PUT/GET" .-> s3
  worker --> s3
```

| Service | Does | Talks to |
|---|---|---|
| `apps/web` | renders the UI; no backend code | the API, on the same origin |
| `apps/api` | auth (better-auth), the oRPC API (`/rpc`, `/api/v1`), the MCP server for todos, billing | Postgres, Valkey, the AI service, Stripe, object storage (presigning) |
| `apps/worker` | the outbox relay, audit log, upload checks, realtime nudges, scheduled housekeeping | Postgres, Valkey, object storage, ClamAV |
| `apps/notifications` | every email, in-app notification, push and text | Postgres, Valkey, email/SMS/push providers |
| `apps/webhooks` | inbound provider webhooks (Stripe), outbound customer webhooks | Postgres, Valkey, customer endpoints |
| `apps/ai` + `ai-worker` | documents, retrieval, the assistant, summaries, the MCP server for documents | Postgres (pgvector), Valkey, model providers, the API's JWKS |
| `apps/mobile` | the Expo app | the API, on the site's origin |

Services never import each other (`lint:boundaries`, rule `no-app-imports-app`). They
share `packages/*` and talk through the API contract, queues and events. The only direct
service-to-service call is the API calling the AI service, with a typed client and a
token it signs per call.

Locally the gateway's job is done by `next.config.ts` rewrites (`/rpc`, `/api`, `/docs`,
the OAuth discovery documents and `/ai/mcp`), so the browser sees one origin in both
setups. Inbound Stripe webhooks go straight to `localhost:3004/webhooks/stripe`.

## A request

1. The browser calls `/rpc/<procedure>` on the site's origin (web and mobile use the
   oRPC protocol through `packages/client`); third parties call the same procedures over
   REST at `/api/v1/...`, described by `/api/v1/openapi.json` (interactive reference at
   `/docs` outside production).
2. The gateway routes it to apps/api. Fastify resolves the client IP through
   `TRUSTED_PROXIES`, and every request runs in a request context (request id, locale,
   client version) that logs, queued jobs and outbox events inherit.
3. The procedure pipeline (`apps/api/src/rpc/procedures.ts`) is the only one: version
   gate, session or API key, membership in the active organization, role, and error
   mapping, identical for RPC and REST. Input is validated by the contract's zod schema.
4. The feature module (`apps/api/src/modules/<feature>`: router, service, repository)
   queries through `withTenant` / `tenantTx`, so Postgres row-level security scopes it to
   the organization, and writes its domain events to the outbox in the same transaction.
5. Errors leave as stable codes (`packages/contracts/src/errors.ts`) with parameters;
   clients translate `errors.<code>` themselves.

Other routes on the API: `/api/auth/*` (better-auth), `/api/mcp` (MCP),
`/api/v1/files/<id>/content` (redirect to a signed download),
`/api/v1/notifications/unsubscribe` (one-click unsubscribe), `/health/live` and
`/health/ready` (every backend service has these; the web app's probe is `/healthz`).

## Auth and tenancy

better-auth in apps/api: email and password with emailed codes, passkeys, Google, TOTP,
server-side sessions in Redis with a Postgres copy, organizations with owner, admin and
member roles, workspace API keys with scopes, and an OAuth 2.1 server for MCP clients.
See [auth.md](auth.md).

The tenant is the organization ("workspace"). Every user gets a personal one at sign-up;
a session has one active organization, and the API re-checks membership on every call.
Tenant tables carry `org_id` (or `user_id` for per-user data) and forced row-level
security keyed on a transaction-local setting, so a query without it sees nothing, in
every service and in Python too. See [database.md](database.md).

## Async work

A change and its event commit together (transactional outbox); the worker's relay copies
events into one BullMQ queue per consumer (audit, webhooks, notifications, billing,
realtime), and every consumer is idempotent. Work that can be re-created (emails, upload
checks, indexing) goes straight to typed queues. Live UI updates are Redis pub/sub
nudges streamed to clients over `/rpc`. See [jobs-and-events.md](jobs-and-events.md).

## Where things live

| Concern | Where |
|---|---|
| API contract, input schemas, limits, error codes | `packages/contracts/src/api`, `errors.ts` |
| Request pipeline (auth, tenancy, errors) | `apps/api/src/rpc/procedures.ts` |
| Auth configuration | `apps/api/src/auth/auth.ts` |
| Optional features and their switches | `apps/api/src/features.ts`, each service's `src/env.ts` |
| Schema, migrations, tenancy helpers, test databases | `packages/db` |
| Queues, job payloads, event routing | `packages/jobs/src/queues.ts` |
| Domain events | `packages/contracts/src/events.ts` |
| Outbox writer | `packages/nest-common/src/outbox.ts` |
| Shared Nest plumbing (bootstrap, env fragments, db, Redis, logging, health, rate limits, storage, crypto) | `packages/nest-common` |
| Client hooks for web and mobile | `packages/client` |
| Every user-facing string | `packages/i18n` |
| Email templates | `packages/email` |
| Web components and design tokens | `packages/ui` |
| Python service | `apps/ai` ([python-services.md](python-services.md)) |
| Deploy: images, charts, GitOps, infra | `docker-bake.hcl`, `deploy/`, `infra/tofu` ([deploy.md](deploy.md)) |

## Seams

Integrations that will change at scale sit behind one interface that callers already
use; each interface's file says how to swap it. The full list, with what each becomes
and the skill that swaps it, is the "Scaling path" table in the [README](../README.md#scaling-path).
