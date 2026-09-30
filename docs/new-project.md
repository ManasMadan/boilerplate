# Starting a new project from this boilerplate

Everything a new app needs once, in order. Each step links to where the details live;
tick them off in your own copy of this file or in an issue.

## 1. Make it yours

- [ ] Create the repository from this one (it's a template repository once its settings
      are applied, see step 3): `gh repo create <owner>/<name> --template
      ManasMadan/boilerplate --public --clone`.
- [ ] Rename the owner, repository and product. `git grep -n -i "manasmadan"` lists the
      repository (Argo CD's `repoURL`s, `infra/tofu/modules/bootstrap/variables.tf`),
      the image registry (`ghcr.io/<owner>/<repo>`: `deploy/charts/stack/values.yaml`,
      `deploy.yml`, `preview.yml`, `docker-bake.hcl`, the image-signing policy in
      `deploy/platform/config/values.yaml`, and the chart tests that assert them),
      `.github/CODEOWNERS` and the security links. `git grep -n "Boilerplate"` finds
      the product name: better-auth's app name, the two-factor issuer and passkeys'
      relying party (`apps/api/src/auth/auth.ts`), the API docs' title, `EMAIL_FROM`
      and the UI's messages (`packages/i18n`).
- [ ] Your domains in `deploy/environments/{staging,production}/`: `site.host`,
      `storage.uploads.host` and `corsOrigins` (data.yaml), `EMAIL_FROM`. The
      `example.com` values there are placeholders.
- [ ] Drop what you don't need with its skill (`.claude/skills`): each optional feature
      is off until its variables are set, so unused ones cost nothing but code.

## 2. Develop locally

- [ ] `bun run setup`: writes `.env` from `.env.example` with fresh local secrets, starts
      the local services and migrates. `bun run doctor` checks the toolchain and warns
      about variables in `.env` that `.env.example` no longer has (after pulling a
      change that removed some): delete those lines by hand.
- [ ] `bun run dev`, then the tests (`CLAUDE.md` has the commands).

## 3. The GitHub repository

[repository-settings.md](repository-settings.md) has each setting, and the commands.

- [ ] Merge settings, the `master` ruleset, security features, environments.
- [ ] The GitHub App (the web UI only): the staging deploy pushes to `master` with it,
      and Renovate runs as it.
- [ ] After the first images are pushed: link each GHCR package to the repository and
      choose its visibility.

## 4. Secrets for each environment

[deploy/README.md](../deploy/README.md), "Secrets with SOPS" and "Credentials".

- [ ] An age key pair per environment (`age-keygen -o <env>.agekey`) and one for you;
      the public keys in `.sops.yaml` (its keys are placeholders, and `sops` refuses
      them). Keep each environment's private key outside the repository: it's the only
      way to decrypt that environment's secrets.
- [ ] The DKIM key pair for mail ([infra/tofu/README.md](../infra/tofu/README.md), DNS).
- [ ] The encrypted Secrets: one per service in `deploy/environments/<env>/secrets/`,
      and the platform's (Cloudflare token, mail server, GitHub token for previews,
      Grafana) in `deploy/platform/secrets/<env>/`. The table in deploy/README.md lists
      every key. `bun run charts:check` refuses any file there that isn't encrypted.

## 5. Machines, DNS and the cluster

[infra/tofu/README.md](../infra/tofu/README.md).

- [ ] Machines anywhere (one for staging is enough; production can grow to three
      servers and agents), a state bucket, a Cloudflare zone and API token.
- [ ] `<env>.tfvars` from the example; `tofu apply`; put its outputs (the DNS token,
      Turnstile keys) into the SOPS secrets.
- [ ] Reverse DNS of the mail node set to `mail.<domain>` at the machines' provider.
- [ ] The infra workflow's secrets per `infra-<env>` environment, to plan and apply from
      CI (repository-settings.md).

## 6. The first deploy: check what only a real cluster shows

CI tests everything it can against local stand-ins (kind, fake providers, a local
Stalwart and RustFS); these need the real environment, once:

- [ ] Argo CD shows every application synced and healthy (`kubectl -n argocd get
      applications`), which also proves it decrypted the SOPS secrets.
- [ ] The site loads through Cloudflare, and `tofu output dns_records` matches the zone.
- [ ] Going around Cloudflare fails: `curl -v --resolve <site>:443:<node-ip>
      https://<site>/` ends in a TLS alert (the gateway wants Cloudflare's origin-pull
      certificate), so nobody can forge the client address rate limits use.
- [ ] Mail: sign up with a real address; the email arrives, not in spam, with DKIM,
      SPF and DMARC passing (the message's `Authentication-Results` header). Send to a
      non-existent address at a real domain: the bounce reaches the webhooks service and
      the address is suppressed (notifications' logs).
- [ ] Backups: `kubectl -n boilerplate get backups` shows a completed one, and a restore
      into a new cluster works (deploy/README.md, "Backups and restore": try it on
      staging before production needs it).
- [ ] Uploads: a profile picture uploads and shows (RustFS through the files host).
- [ ] With observability on: traces in Jaeger and metrics in Grafana for every service.
- [ ] Re-encryption: `kubectl -n boilerplate create job --from=cronjob/boilerplate-reencrypt
      reencrypt-$(date +%s)` completes (the rotate-secrets skill).
- [ ] Third-party providers you turned on, each with a real account once: Google
      sign-in, Stripe test mode, Twilio, push on real devices, the AI provider.

## 7. Releasing

[deploy.md](deploy.md), "Releases → production", and the release skill.

- [ ] The first release, on a commit that deployed to staging (the merge, or the staging
      bump right after it): `git tag v0.1.0 && git push origin v0.1.0`, then
      `bun run promote v0.1.0` to open production's promotion pull request.
