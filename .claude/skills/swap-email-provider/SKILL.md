---
name: swap-email-provider
description: Add or switch the email delivery provider (SES, Postmark, SendGrid, Mailgun or another HTTP API). Use when the user wants to send email through a different service, or email fails in production because of the provider.
---

# Swap the email provider

- **Interface:** `EmailTransport` (`send(email): Promise<{ providerMessageId }>`) in
  `apps/notifications/src/channels/email/email-transport.ts`.
- **Today:** `SmtpTransport` (any SMTP server: Mailpit locally; SES, Postmark or SendGrid
  over SMTP) and `ResendTransport` (Resend's HTTP API).
- **Selected in:** `createTransport()` in `apps/notifications/src/channels/email/email.module.ts`
  by `EMAIL_PROVIDER`.
- **Env:** `EMAIL_PROVIDER` (`smtp` | `resend`), `SMTP_URL`, `RESEND_API_KEY`, `EMAIL_FROM`.

A provider with SMTP needs no code: set `EMAIL_PROVIDER=smtp` and its `SMTP_URL`.

## Add an HTTP provider

1. A class implementing `EmailTransport` next to the others. Send `idempotencyKey` as
   the provider's idempotency key (retried jobs must not double-send), pass `headers`
   through (List-Unsubscribe), set a request timeout, and throw on non-2xx.
2. Add its name to the `EMAIL_PROVIDER` enum and its key to
   `apps/notifications/src/env.ts`, with a boot-time check that the key is present
   (like `resend`), plus `.env.example` and `docs/environment.md`.
3. A `case` for it in `createTransport()`.
4. Deployed: the key goes in `service_secrets.notifications` (rotate-secrets skill).

The SMS email sink (`apps/notifications/src/channels/sms/email-sink.ts`) always uses SMTP
and is for development only.

## Tests

`apps/notifications/test/notifications.integration.test.ts` reads delivered mail from
Mailpit (SMTP). For an HTTP provider, add a small local fake of its API (like
`apps/notifications/test/fake-twilio.ts`) and a test that sends through it.
