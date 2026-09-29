# Web and mobile

Both apps are clients of the same API, through the same package (`packages/client`),
with the same copy (`packages/i18n`) and design tokens (`packages/ui/src/styles/theme.css`).

## apps/web (Next.js)

### Render-only

The web app renders UI and nothing else: no route handlers (except the health probe,
`app/healthz/route.ts`), no server actions, no database, queues or auth-server code.
`bun run lint:boundaries` enforces it (`scripts/check-web-render-only.ts` and the
`web-has-no-backend-code` rule in `.dependency-cruiser.cjs`).

The reason: auth, tenancy, validation, rate limits and error mapping live in one request
pipeline in apps/api, which web, mobile, API keys and MCP clients all go through. A
server action would be a second, unguarded backend that only the web app could use, and
one the mobile app and the REST API would drift from.

It still runs as a Node server (`output: "standalone"`), to render public pages on the
server, redirect signed-out users before any HTML is sent, set a per-request CSP nonce
(`src/proxy.ts`) and serve dynamic routes like `/invitations/[id]`.

### One origin

The browser calls the API on the site's own origin: `/rpc` (web and mobile),
`/api/auth` and `/api/v1`. When deployed, the gateway routes those paths to apps/api
before they reach Next; locally, the rewrites in `next.config.ts` forward them to
`API_URL` (and `/ai/mcp` to `AI_URL`). Cookies stay first-party, there's no CORS, and
nothing environment-specific is built into the bundle: every variable in
`src/env.ts` is server-only.

### Layout

```
src/app/                    routes: each page.tsx only picks a module's page and its title
src/modules/<feature>/      pages/, components/, hooks/, lib/, and index.ts (its public surface)
src/components/, src/lib/   the few things every module shares (form fields, captcha, routes)
```

A module is private except its `index.ts` (the `web-modules-only-via-barrel` rule);
code two modules need moves to `packages/ui` or `packages/client`. The app uses typed
routes and the React Compiler.

### Data

Every call goes through `packages/client`:

- `ApiProvider` (mounted in `src/app/providers.tsx`) creates the oRPC client for the
  contract in `packages/contracts` and its TanStack Query utilities, sending
  `x-app-version` and `x-locale` with every request.
- Hooks live one per procedure and are imported by exact path:
  `import { useTodoListInfiniteQuery } from "@repo/client/api/todo/list"`.
- `@repo/client/auth` is the better-auth client (with its plugins), `@repo/client/auth/forms`
  the shared form schemas, `useLiveUpdates` the realtime stream that invalidates queries,
  and `errorMessageKey`/`fieldErrors` turn API error codes into translated messages.

A new procedure gets its hook in `packages/client/src/api/<feature>/`; apps never call
`fetch` for API data.

### i18n

next-intl, with every message from `packages/i18n/messages/<locale>.json` (English and
Spanish today). Each server render picks the `locale` cookie, then `Accept-Language`,
then English, and the time zone from the `tz` cookie (`src/i18n/request.ts`), so HTML
arrives translated. Every catalog is type-checked against English, so a missing key
fails `check-types`. To add a language: copy `messages/en.json`, translate it, and add the
code to `locales` and `catalogs` in `packages/i18n/src/index.ts`.

### Bundle budget

`bun run --cwd apps/web budget` (after `next build`) fails when a route's first-load
JavaScript, gzipped, passes its budget, or the part every route shares grows past its
own (`scripts/bundle-budget.ts`). CI runs it after the end-to-end suite. Raise a budget
only on purpose, in the change that needs it.

## packages/ui

The web component library: shadcn-style components on Tailwind v4
(`components.json`), imported by path (`@repo/ui/components/button`). `theme.css` holds
the design tokens both apps use.

Every component has stories:

```sh
bun run --cwd packages/ui storybook      # http://localhost:6006
bun run --cwd packages/ui test:stories   # each story renders, runs its play function and passes axe, light and dark
bun run --cwd packages/ui test:visual    # screenshot of every story in both themes against the baselines (Docker)
bun run --cwd packages/ui test:visual:update
```

`test:visual` builds Storybook and runs Playwright in the official Playwright image, so
screenshots are identical on every machine and in CI.

## apps/mobile (Expo)

- **Expo Router**: screens in `src/app` (`(auth)`, `(app)`, `invitations/[id]`,
  `update-required`), typed routes.
- **Uniwind**: Tailwind classes on React Native, with the tokens from
  `@repo/ui/theme.css` (`global.css`). Its components are its own
  (`src/components/ui`, on rn-primitives); `packages/ui` is for the web.
- **Data and auth**: the same `ApiProvider` and hooks as the web app, with an absolute
  `EXPO_PUBLIC_API_URL` and the session cookie from secure storage (better-auth's Expo
  plugin). An API answer of `CLIENT_OUTDATED` (older than `MINIMUM_CLIENT_VERSION`)
  shows the update screen.
- **i18n**: use-intl with the same catalogs.
- **Push**: `expo-notifications` gets the native FCM or APNs token and registers the device
  with the API (`src/lib/push.ts`).
- Native projects (`ios/`, `android/`) come from `expo prebuild` and aren't committed.

| Command (`bun run --cwd apps/mobile …`) | What it does |
|---|---|
| `dev` | Metro and the Expo dev server |
| `ios`, `android` | build and install a development build |
| `build:web`, `serve:web` | the app rendered for the web, served on :3100 with the API on its own origin (the mobile end-to-end suite runs against it) |
| `test` | Jest (React Native Testing Library) |
| `test:e2e` | Playwright against the web build |
| `doctor` | expo-doctor |

### EAS builds and over-the-air updates

`apps/mobile/eas.json` has three profiles; `APP_VARIANT` gives each its own name and
bundle id, so all three install side by side:

| Profile | Distribution | Channel |
|---|---|---|
| `development` | internal, development client (iOS simulator) | `development` |
| `preview` | internal | `preview` |
| `production` | stores, build number auto-incremented | `production` |

`.github/workflows/mobile.yml` moves the app like the other services:

- a push to `master` touching the app or the packages it uses publishes an over-the-air
  update to the `preview` channel;
- a published release builds both platforms with the `production` profile and submits
  them to the App Store and Google Play;
- a manual run publishes an update to `preview` or `production` (a hotfix).

Updates reach only builds of the same app version (`runtimeVersion: appVersion`), so
native changes always ship through a store release. The workflow is skipped until the
`EAS_PROJECT_ID` repository variable is set; it also needs the `EXPO_TOKEN` secret,
`EXPO_PUBLIC_API_URL` per EAS environment and store credentials in EAS (`bunx eas-cli
credentials`). See [repository-settings.md](repository-settings.md).

### Native flows (Maestro)

`apps/mobile/maestro` checks what only a real build can: the session surviving a restart
(`sign-up-and-restart.yaml`), the permission prompt and push token registration
(`push.yaml`), and links opened by the OS (`invitation-link.yaml`). Run them against a
development build with the stack up; see `apps/mobile/maestro/README.md`. They don't
run in CI.

## Shared packages

| Package | What it is |
|---|---|
| `packages/contracts` | the API contract, input schemas, limits, error codes, events, plans |
| `packages/client` | the typed API client, hooks, auth client, realtime (web and mobile) |
| `packages/ui` | web components, design tokens, Storybook |
| `packages/i18n` | every user-facing string, for every surface |
| `packages/email` | React Email templates (server-side only) |
| `packages/testing` | test helpers (TOTP codes) |

The apps may not import `packages/db`, `nest-common`, `jobs`, `logger` or `email`, nor
server frameworks (enforced by `lint:boundaries`).
