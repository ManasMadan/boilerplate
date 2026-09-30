/**
 * UserPromptSubmit: fingerprint the working tree's content, so the Stop hook can tell
 * whether this turn changed anything (answering a question must not trigger a
 * verification run), and start the turn's re-check count from zero.
 */

import { rmSync } from "node:fs";
import { readInput, stopCountFile, treeFingerprint, turnFile } from "./lib";

const input = await readInput();
await Bun.write(turnFile(input.session_id), await treeFingerprint());
rmSync(stopCountFile(input.session_id), { force: true });
