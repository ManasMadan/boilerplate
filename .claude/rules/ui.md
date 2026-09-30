---
paths:
  - "packages/ui/**"
---

# packages/ui

The web component library: shadcn-style components (`components.json`, style
`base-nova`, on Base UI) with Tailwind v4, and the design tokens both apps use.

- A component is `src/components/<name>.tsx`, imported by path
  (`@repo/ui/components/<name>`); there's no barrel. Adding one from the registry:
  `bunx shadcn@latest add <name> --cwd packages/ui`, then make it pass lint and types
  like the rest (no `any`, no suppressions).
- Every component has `src/components/<name>.stories.tsx`, with a `play` function for
  anything interactive. `bun run --cwd packages/ui test:stories` renders each story in
  Chromium in the light and dark themes, runs its `play`, and fails on any axe
  violation: a component without an accessible name or with poor contrast fails here.
- Visual baselines: `bun run --cwd packages/ui test:visual` compares every story with
  `visual/__screenshots__` in the Playwright Docker image (so screenshots match CI).
  A deliberate visual change: `test:visual:update`, and commit the new screenshots.
- Colours, radii and spacing come from the tokens in `src/styles/theme.css` (CSS
  variables per theme). Never a literal colour in a component; add a token if one is
  missing, for both themes. Mobile reads the same file (`apps/mobile/global.css`).
- No text of its own: labels and copy are props, translated by the app. Icons from
  `lucide-react`.
- Components are presentational: no data fetching, no `@repo/client`, nothing
  server-only. React Server Components can import them (`"use client"` only where a
  component needs state or effects).
