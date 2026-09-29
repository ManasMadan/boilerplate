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
3. Re-encrypt the stored secrets with the new key (safe while the services run, safe
   to repeat): `bun run secrets:reencrypt` locally; deployed,
   `kubectl -n boilerplate exec deploy/boilerplate-api -- /nodejs/bin/node dist/reencrypt.mjs`.
   It prints how many rows moved; a second run prints 0.
4. Only then drop the old key from both services and apply. Dropping it earlier makes
   endpoints still on it undeliverable ("Unknown encryption key").

Never `tofu apply -replace` the `random_bytes.encryption_key` resource: it replaces the
only key and every stored secret becomes unreadable.

## Customer webhook signing secrets

Per endpoint: the "Rotate secret" button in workspace settings (the `webhooks.rotateSecret`
procedure, owners and admins). The old secret keeps signing next to the new one for
`WEBHOOK_SECRET_OVERLAP_HOURS` (24, `packages/contracts/src/api/webhooks.ts`): each
delivery carries both signatures, so the customer's receiver accepts it with either
secret while they switch. Rotating again inside the window drops the oldest. It records
`webhook.secret_rotated.v1` in the audit log. For a leaked secret, rotate twice: the
second rotation retires the leaked one at once.

## Shared secrets (UNSUBSCRIBE_SECRET, AI_SERVICE_SECRET)

Both sides must change together: UNSUBSCRIBE_SECRET in api and notifications,
AI_SERVICE_SECRET in api and ai (`apps/ai/app/settings.py`). Set the new value for both
services in `service_secrets`, apply, restart both. Unsubscribe links in emails already
sent stop working; AI calls fail until both sides run the new value (tokens live 60 s).

## BETTER_AUTH_SECRET

better-auth signs session cookies with it and encrypts OAuth tokens, two-factor secrets
and backup codes, and the JWT signing keys (OAuth and MCP tokens) with it. Never just
replace it: everything encrypted becomes unreadable. Rotate with versioned secrets
(`apps/api/src/auth/secrets.ts`):

1. Generate one: `openssl rand -base64 48`. Set `BETTER_AUTH_SECRETS` for the api,
   newest first: `1:<new>` the first time, then `2:<newer>,1:<new>` and so on. Keep
   `BETTER_AUTH_SECRET` as it is: it still decrypts values written before versions.
   Deployed, `BETTER_AUTH_SECRETS` goes under `api` in `service_secrets`; locally
   `bun run env:set BETTER_AUTH_SECRETS=1:<new>`.
2. Apply and restart the api. Every session cookie is signed with the newest secret
   only, so everyone signs in again once; nothing else breaks.
3. Re-encrypt: `bun run secrets:reencrypt` (deployed: the `kubectl exec` command in the
   ENCRYPTION_KEYS section). It moves every stored value to the newest version.
4. Then older versions can go from `BETTER_AUTH_SECRETS`. The legacy
   `BETTER_AUTH_SECRET` is still required by the api's environment; once re-encryption
   has run, its value no longer protects anything and can be replaced with a fresh one.

## Provider keys (Stripe, Resend, Twilio, FCM, APNs, Google)

Create the new key at the provider, put it in `service_secrets` for the service that
uses it (`STRIPE_WEBHOOK_SECRET` belongs to webhooks, `STRIPE_SECRET_KEY` to api, the
push and SMS keys to notifications; see each app's `src/env.ts`), apply, restart that
service, then revoke the old key.
