---
name: dev
description: Start, stop or troubleshoot the local development stack. Use when the user wants to run the app, see it in the browser, turn on optional services (AI, file uploads, billing), or when a local service or app fails to start.
---

# Local development

- `bun dev` runs the core profile: Postgres, Valkey and Mailpit in Docker, plus web
  (http://localhost:3000), api (http://localhost:3001) and the worker (:3002),
  notifications (:3003) and webhooks (:3004) services, all in turbo's terminal UI.
- `bun dev:full` adds every optional service: the Python AI service (:8000), S3 storage
  (RustFS, console :9001), ClamAV, and everything else. Billing without a Stripe
  account: `bun run stripe:fake` (see the Billing block in .env.example).
- Customer webhooks can point at a local receiver on 127.0.0.1 (allowed by
  WEBHOOK_ALLOWED_PRIVATE_ADDRESSES in .env; refused in production). For real Stripe
  test events, run `stripe listen --forward-to localhost:3004/webhooks/stripe` and set
  the printed secret with `bun run env:set STRIPE_WEBHOOK_SECRET=whsec_...`.
- Emails never leave the machine: open Mailpit at http://localhost:8025 to read sign-up
  codes and notifications.

## Troubleshooting

1. `bun run doctor`. It lists the exact fix for tools, `.env` drift and services.
2. Service logs: `docker compose logs <postgres|valkey|mailpit|rustfs> --tail 100`.
3. App logs are in the turbo UI. Every request has an `x-request-id`; search logs by it.
4. After changing the Prisma schema, Pydantic models or the API contract, run `bun run gen`.
5. Stale state: `bun run db:down` then `bun dev` (keeps data). Wiping data
   (`docker compose down -v`) needs the user's confirmation.
