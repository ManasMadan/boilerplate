---
name: rotate-secrets
description: Rotate or replace a secret or key (ENCRYPTION_KEYS, BETTER_AUTH_SECRET, UNSUBSCRIBE_SECRET, AI_SERVICE_SECRET, customer webhook signing secrets, provider keys). Use when a secret leaked, a key is due for rotation, or the user asks how rotation works here.
---

# Rotate secrets

Where secrets live: locally in `.env` (never read it; set values with
`bun run env:set KEY=value`). Deployed, in the cloud secret manager as one JSON object per
service (`<prefix><service>`), written by OpenTofu (`infra/tofu/modules/app-secrets`):
it generates `BETTER_AUTH_SECRET`, `ENCRYPTION_KEYS`, `UNSUBSCRIBE_SECRET` and
`AI_SERVICE_SECRET` once and keeps them in state, and merges `service_secrets` from the
environment's tfvars over them. External Secrets copies them into the cluster every
15 minutes (`deploy/charts/stack/values.yaml`); services read variables at start, so
restart the affected deployments after it syncs
(`kubectl -n boilerplate rollout restart deployment/boilerplate-<service>`).

Changes to tfvars go through `.github/workflows/infra.yml`: the environment's tfvars
live in its `TOFU_TFVARS` secret; run the workflow with apply for that cloud and
environment.

## ENCRYPTION_KEYS (webhook signing secrets at rest)

`id:base64key` entries, 32-byte keys; the first encrypts, every listed one decrypts
(`packages/nest-common/src/crypto.ts`). api and webhooks must hold the same value.

1. New key: `echo "$(date +%Y-%m):$(openssl rand -base64 32)"`.
2. Prepend it, keeping the old one: `ENCRYPTION_KEYS = "<new>,<old>"` under both `api`
   and `webhooks` in `service_secrets` (the old value is in the secret manager). Apply,
   wait for the sync, restart api and webhooks. Locally the user edits `.env` themselves
   (you can't read the old value); only if local webhook endpoints don't matter, set a
   fresh single key with `bun run env:set`.
3. Keep the old key listed. Nothing re-encrypts existing rows yet: `SecretBox.needsRotation`
   exists but no job calls it, and a row moves to the new key only when its endpoint's
   secret is rotated. Dropping a key while rows still use it makes those endpoints
   undeliverable ("Unknown encryption key").

Never `tofu apply -replace` the `random_bytes.encryption_key` resource: it replaces the
only key and every stored secret becomes unreadable.

## Customer webhook signing secrets

Per endpoint: the "Rotate secret" button in workspace settings (the `webhooks.rotateSecret`
procedure, owners and admins). The new secret replaces the old one at once, with no
overlap, so the customer must switch their verifier at the same time. It records
`webhook.secret_rotated.v1` in the audit log.

## Shared secrets (UNSUBSCRIBE_SECRET, AI_SERVICE_SECRET)

Both sides must change together: UNSUBSCRIBE_SECRET in api and notifications,
AI_SERVICE_SECRET in api and ai (`apps/ai/app/settings.py`). Set the new value for both
services in `service_secrets`, apply, restart both. Unsubscribe links in emails already
sent stop working; AI calls fail until both sides run the new value (tokens live 60 s).

## BETTER_AUTH_SECRET

There is no safe rotation today. better-auth signs sessions with it and encrypts
two-factor secrets and the JWT signing keys (OAuth and MCP tokens) with it, and
`apps/api/src/auth/auth.ts` passes a single `secret`. Replacing it signs everyone out
and breaks existing two-factor enrolments and issued tokens. better-auth supports
versioned secrets, but wiring them in is a code change to `auth.ts` and `apps/api/src/env.ts`.

## Provider keys (Stripe, Resend, Twilio, FCM, APNs, Google)

Create the new key at the provider, put it in `service_secrets` for the service that
uses it (`STRIPE_WEBHOOK_SECRET` belongs to webhooks, `STRIPE_SECRET_KEY` to api, the
push and SMS keys to notifications; see each app's `src/env.ts`), apply, restart that
service, then revoke the old key.
