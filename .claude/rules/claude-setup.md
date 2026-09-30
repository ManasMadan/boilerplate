---
paths:
  - ".claude/**"
  - "CLAUDE.md"
  - "**/CLAUDE.md"
  - ".mcp.json"
---

# The Claude Code setup

- `.claude/settings.json` and `.claude/hooks/` are guard rails: the edit guard asks the
  user before either changes. Don't weaken a check to get past it; if a hook is wrong,
  say how and let the user decide.
- Hooks are TypeScript run with Bun, one file per hook event plus shared code in
  `lib.ts`, `checks.ts`, `file-rules.ts`, `shell.ts` and `suppressions.ts`. Logic lives
  in those shared modules with a `*.test.ts` beside each. Each hook exports a handler
  that takes the event, and what it would run or check as parameters with the real ones
  as defaults, and returns its answer; `import.meta.main` is one line that calls it,
  usually `process.exit(await runHook(handler))` (`runHook` in lib.ts reads the event
  from stdin and writes the answer). Tests call the handler with stand-ins. `tsc -p .claude/hooks` runs in
  `bun run check-types`, and `bun test ./.claude/hooks/` in the pre-push hook and CI. A hook fails
  closed where a wrong "allow" is costly, and every message it sends says what to do.
- Skills are `.claude/skills/<name>/SKILL.md`: frontmatter, then numbered steps with the
  exact files, commands and tests, ending with how to check it's done (the verify skill,
  and the reviewer agents that apply). Only fields Claude Code documents
  (code.claude.com/docs/en/skills): `description` says what and when, `argument-hint`
  for arguments, `disable-model-invocation: true` for anything a human should start
  (releases, rollbacks, secret rotation, seam swaps). Skills are also the human
  runbooks: plain steps, no reliance on hidden context.
- Agents are `.claude/agents/<name>.md` with `name`, a `description` that says when to
  use it proactively, `tools`, `model` and `permissionMode`. Read-only agents set
  `disallowedTools: Edit, Write, NotebookEdit`. Fields as in
  code.claude.com/docs/en/sub-agents.
- Rules are `.claude/rules/<area>.md` with `paths` frontmatter (the only field Claude
  Code reads); they state this repo's conventions for those files, not general advice.
- Keep in sync in the same change: a new skill goes in `docs/README.md`'s runbook list;
  a new agent, rule area or MCP server in `CLAUDE.md`'s "Claude Code setup"; a new
  command in `CLAUDE.md`'s table. Every app and `packages/db` has a `CLAUDE.md` with its
  commands, where things are, and its gotchas.
- `CLAUDE.md` and the rules are loaded into every session: keep them short and
  specific. No decision IDs, no history, no mention of private notes.
