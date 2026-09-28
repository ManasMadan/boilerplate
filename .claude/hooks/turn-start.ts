/**
 * UserPromptSubmit: snapshot the working tree, so the Stop hook can tell whether this
 * turn changed any files (answering a question must not trigger a verification run).
 */

import { join } from "node:path";
import { $ } from "bun";
import { ROOT, readInput, STATE_DIR } from "./lib";

const input = await readInput();
const snapshot = await $`git status --porcelain=v1 -uall`.cwd(ROOT).quiet().nothrow().text();
const diff = await $`git diff --stat HEAD`.cwd(ROOT).quiet().nothrow().text();
await Bun.write(join(STATE_DIR, `turn-${input.session_id}.txt`), snapshot + diff);
