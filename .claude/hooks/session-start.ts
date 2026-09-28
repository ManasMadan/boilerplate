/**
 * SessionStart: give Claude a one-line health summary of the machine (tools, .env
 * drift, local services) from `bun run doctor`, cached for 10 minutes so starting a
 * session stays instant.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { $ } from "bun";
import { ROOT, respond, STATE_DIR } from "./lib";

const cache = join(STATE_DIR, "doctor.txt");
const fresh = existsSync(cache) && Date.now() - statSync(cache).mtimeMs < 10 * 60_000;
if (!fresh) {
  const output = await $`bun scripts/doctor.ts`.cwd(ROOT).quiet().nothrow().text();
  await Bun.write(cache, stripVTControlCharacters(output));
}
const summary = await Bun.file(cache).text();
respond({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: `Local environment check (bun run doctor):\n${summary}\nIf problems are listed, fix them first (usually \`bun run setup\` or \`bun run db:up\`).`,
  },
});
