/**
 * SessionStart: give Claude a one-line health summary of the machine (tools, .env
 * drift, local services) from `bun run doctor`, cached for 10 minutes so starting a
 * session stays instant.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { STATE_DIR, shell } from "./lib";

/** The doctor's summary for Claude, from `cache` while it's fresh. */
export async function sessionStart(
  run = shell,
  cache = join(STATE_DIR, "doctor.txt"),
): Promise<Record<string, unknown>> {
  const fresh = existsSync(cache) && Date.now() - statSync(cache).mtimeMs < 10 * 60_000;
  if (!fresh) {
    const { stdout } = await run(["bun", "scripts/doctor.ts"]);
    await Bun.write(cache, stripVTControlCharacters(stdout));
  }
  const summary = await Bun.file(cache).text();
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Local environment check (bun run doctor):\n${summary}\nIf problems are listed, fix them first (usually \`bun run setup\` or \`bun run db:up\`).`,
    },
  };
}

if (import.meta.main) process.stdout.write(JSON.stringify(await sessionStart()));
