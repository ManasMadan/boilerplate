# Docs

Start with `CONTRIBUTING.md` (setup and conventions) and `CLAUDE.md` (commands and
principles). Starting a new app from this repository: [new-project.md](new-project.md),
the checklist from the first clone to the first production release.

| Doc | What's in it |
|---|---|
| [architecture.md](architecture.md) | the deployables, how a request flows, where each concern lives, the seams |
| [environment.md](environment.md) | every environment variable, which service reads it and what it switches on |
| [database.md](database.md) | schemas and owners, roles, row-level security, migrations, test databases, the restore drill |
| [codegen.md](codegen.md) | what `bun run gen` generates and from what, and the CI checks on it |
| [jobs-and-events.md](jobs-and-events.md) | queues, typed jobs, the outbox and relay, the event catalog, adding a job or event |
| [auth.md](auth.md) | sign-in methods, sessions, organizations and roles, API keys, OAuth for MCP, rate limits |
| [notifications.md](notifications.md) | channels, templates, preferences, digests, quiet hours, unsubscribe, adding a notification |
| [files-and-billing.md](files-and-billing.md) | the upload pipeline and storage; Stripe billing, plans and the fake Stripe |
| [python-services.md](python-services.md) | apps/ai: the assistant, retrieval, summaries, the worker, the MCP server, evals |
| [web-and-mobile.md](web-and-mobile.md) | the render-only web app, packages/client and ui, the Expo app, EAS and OTA updates |
| [testing.md](testing.md) | every test layer and its command, coverage floors, what CI runs and when |
| [deploy.md](deploy.md) | images, environments, staging and production releases, rollback, previews |
| [new-project.md](new-project.md) | everything a new app made from this boilerplate needs once, in order |
| [repository-settings.md](repository-settings.md) | the GitHub settings (and the `gh` commands that apply them), App, environments and secrets the workflows need |

Elsewhere: [deploy/README.md](../deploy/README.md) (charts and GitOps),
[infra/tofu/README.md](../infra/tofu/README.md) (k3s on your machines, Cloudflare),
[apps/mobile/maestro/README.md](../apps/mobile/maestro/README.md) (native flows).
