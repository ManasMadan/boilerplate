/**
 * What a shell command line does that the guard rails care about: which files it writes
 * (so the file rules apply to Bash too, not only to Edit and Write) and whether it skips
 * a check, reaches outside the machine or destroys something. Pure and tested
 * (shell.test.ts); bash-guard.ts applies it.
 *
 * It reads ordinary commands (redirects, tee, sed -i, cp, mv, rm, ...). Writes from inside
 * an interpreter (`python -c "open(...)"`) can't be read from the command line, and
 * nothing else stops them: settings.json's deny rules cover Claude's own Read and Edit
 * tools only. That's why settings.json allows only named scripts, not `bun run *`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "./file-rules";
import { ROOT } from "./lib";

/** Whether `bin` is installed in the workspace (node_modules/.bin). */
const installedBin = (bin: string) => existsSync(join(ROOT, "node_modules/.bin", bin));

/** One simple command: its words, after leading `VAR=value` assignments. */
interface Simple {
  env: Record<string, string>;
  words: string[];
  /** Files its redirects write (`>`, `>>`, `&>`, `2>`). */
  redirects: string[];
}

const OPERATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);

/** Words and operators, with quotes and backslashes resolved. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    const next = line[i + 1];
    if (char === "'" || char === '"') {
      const end = line.indexOf(char, i + 1);
      const stop = end === -1 ? line.length : end;
      word += line.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (char === "\\" && next !== undefined) {
      word += next;
      inWord = true;
      i++;
    } else if (char === " " || char === "\t") {
      flush();
    } else if ((char === "&" || char === "|") && next === char) {
      flush();
      tokens.push(char + next);
      i++;
    } else if (char === ">" || (char === "&" && next === ">")) {
      // `2>` and `&>` redirect too: the descriptor digit belongs to the operator.
      const descriptor = /^\d$/.test(word) ? word : "";
      if (descriptor) word = "";
      flush();
      const append = line[i + (char === "&" ? 2 : 1)] === ">";
      tokens.push(`${descriptor}${char === "&" ? "&>" : ">"}${append ? ">" : ""}`);
      i += (char === "&" ? 1 : 0) + (append ? 1 : 0);
      // `>&2` duplicates a descriptor; it writes no file.
      if (line[i + 1] === "&") {
        tokens.pop();
        i++;
        while (/\d/.test(line[i + 1] ?? "")) i++;
      }
    } else if (char === "<" && next === "<") {
      // A heredoc: the body is data, not commands. Skip to its closing marker.
      flush();
      const rest = line.slice(i + 2).replace(/^[-~]?\s*/, "");
      const marker = /^['"]?(\w+)['"]?/.exec(rest)?.[1];
      const bodyStart = line.indexOf("\n", i);
      if (!marker || bodyStart === -1) break;
      const end = line.indexOf(`\n${marker}`, bodyStart);
      tokens.push("\n");
      i = end === -1 ? line.length : end + marker.length + 1;
    } else if (char === "<") {
      // Input: its file is read, not written.
      flush();
      tokens.push("<");
    } else if (OPERATORS.has(char)) {
      flush();
      tokens.push(char);
    } else {
      word += char;
      inWord = true;
    }
  }
  flush();
  return tokens;
}

function simpleCommands(line: string): Simple[] {
  const commands: Simple[] = [];
  let current: Simple = { env: {}, words: [], redirects: [] };
  const tokens = tokenize(line);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (OPERATORS.has(token) || token === "&&" || token === "||") {
      if (current.words.length || current.redirects.length) commands.push(current);
      current = { env: {}, words: [], redirects: [] };
    } else if (token === "<") {
      i++;
    } else if (/^\d?&?>>?$/.test(token)) {
      const target = tokens[i + 1];
      if (target && target !== "/dev/null") current.redirects.push(target);
      i++;
    } else if (!current.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      const [key = "", ...value] = token.split("=");
      current.env[key] = value.join("=");
    } else {
      current.words.push(token);
    }
  }
  if (current.words.length || current.redirects.length) commands.push(current);
  // Wrappers that run the rest of the line as the command.
  return commands.map((command) => {
    const words = [...command.words];
    while (["sudo", "command", "time", "nohup", "exec"].includes(words[0] ?? "")) words.shift();
    if (words[0] === "env") {
      words.shift();
      while (words[0]?.includes("=")) {
        const [key = "", ...value] = (words.shift() as string).split("=");
        command.env[key] = value.join("=");
      }
    }
    return { ...command, words };
  });
}

const operands = (words: string[]) => words.slice(1).filter((word) => !word.startsWith("-"));

/** The files a command writes, as written (relative to its working directory). */
function writesOf({ words, redirects }: Simple): string[] {
  const [program = ""] = words;
  const targets = [...redirects];
  if (program === "tee") targets.push(...operands(words));
  if (["rm", "unlink", "truncate", "shred"].includes(program)) targets.push(...operands(words));
  if (["cp", "mv", "install", "ln", "rsync"].includes(program)) {
    const paths = operands(words);
    if (paths.length >= 2) targets.push(paths.at(-1) as string);
  }
  if (program === "dd") {
    targets.push(...words.filter((word) => word.startsWith("of=")).map((word) => word.slice(3)));
  }
  const inPlace = words.findIndex((word) => /^-[a-z]*i/.test(word) && !word.startsWith("--"));
  if ((program === "sed" || program === "perl") && inPlace !== -1) {
    // After the flags come the script (unless -e gave it) and then the files.
    const rest = words.slice(1).filter((word, index) => {
      if (word.startsWith("-")) return false;
      // macOS `sed -i ''`: the empty suffix follows -i.
      return !(word === "" && words[index] === words[inPlace]);
    });
    // The first operand is the script, whether or not -e introduced it.
    targets.push(...rest.slice(1));
  }
  return targets.filter(Boolean);
}

/** Every file the command line writes. */
export function writeTargets(line: string): string[] {
  return simpleCommands(line).flatMap(writesOf);
}

const deny = (reason: string): Verdict => ({ decision: "deny", reason });
const ask = (reason: string): Verdict => ({ decision: "ask", reason });

/**
 * Worktrunk (`wt`): making, listing and switching worktrees is routine; landing a branch,
 * deleting one, rewriting its history, approving the project's hooks or starting another
 * program in a worktree is the user's call.
 */
function worktrunkVerdict(
  sub: string,
  third: string,
  has: (...flags: string[]) => boolean,
): Verdict {
  if (sub === "merge") {
    return ask(
      "wt merge lands the branch on master locally and removes the worktree; changes reach master through pull requests.",
    );
  }
  if (sub === "remove") return ask("wt remove deletes the worktree and, once merged, its branch.");
  if (sub === "config")
    return ask("wt config changes the user's Worktrunk setup (shell, plugins).");
  if (
    sub === "step" &&
    ["commit", "squash", "push", "rebase", "promote", "prune", "relocate"].includes(third)
  ) {
    return ask(
      `wt step ${third} commits, rewrites or moves branches; it needs the user's approval.`,
    );
  }
  if (has("--yes", "-y")) {
    return ask("--yes approves the project's hooks without the user seeing them first.");
  }
  if (sub === "switch" && has("-x", "--execute")) {
    return ask("wt switch -x starts another program (often another agent) in the worktree.");
  }
  return null;
}

/** What the policy says about one simple command, or null. */
function commandVerdict({ env, words }: Simple, installed: (bin: string) => boolean): Verdict {
  const [program = "", sub = "", third = ""] = words;
  const has = (...flags: string[]) => words.some((word) => flags.includes(word));
  if (env.HUSKY === "0" || env.HUSKY_SKIP_HOOKS) {
    return deny(
      "Skipping the commit hooks (HUSKY=0) skips the checks they run. Fix what they report.",
    );
  }
  if (program === "git") {
    if (
      (sub === "commit" &&
        (has("--no-verify") || words.some((word) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(word)))) ||
      (sub === "push" && has("--no-verify"))
    ) {
      return deny("--no-verify skips the commit and push hooks' checks. Fix what they report.");
    }
    if (sub === "push" && (has("--force", "-f") || words.some((word) => /^\+/.test(word)))) {
      return deny("Force-pushing rewrites shared history; the user does that by hand if ever.");
    }
    if (sub === "push" && words.some((word) => word.startsWith("--force-with-lease"))) {
      return ask("A force push (--force-with-lease) rewrites the branch's history.");
    }
    if (sub === "branch" && has("-D", "--delete"))
      return ask("Deleting a branch loses its commits.");
    if (sub === "reset" && has("--hard")) return ask("git reset --hard discards uncommitted work.");
    if (sub === "clean") return ask("git clean deletes untracked files.");
    // Read-only forms are fine; anything else swaps work in and out of a stack every
    // worktree shares, so one session's stash can land in another's tree.
    if (sub === "stash" && !["list", "show"].includes(third)) {
      return ask(
        "git stash is shared by every worktree of this repository; commit the work, or use another worktree (`wt switch --create`).",
      );
    }
    if (sub === "worktree" && third === "add") {
      return ask(
        "Make worktrees with `wt switch --create <branch>` (.config/wt.toml copies .env and installs).",
      );
    }
    if (sub === "commit") return ask("Commits need the user's approval (CLAUDE.md).");
    if (sub === "push") return ask("Pushing publishes the branch; it needs the user's approval.");
  }
  if (program === "gh") {
    if (sub === "pr" && ["create", "merge", "close", "comment", "review", "edit"].includes(third)) {
      return ask("This changes a pull request on GitHub; it needs the user's approval.");
    }
    if (
      sub === "api" ||
      sub === "release" ||
      sub === "secret" ||
      sub === "variable" ||
      sub === "repo" ||
      sub === "workflow"
    ) {
      return ask("This reaches GitHub on the user's account; it needs their approval.");
    }
  }
  if (program === "sops" && (has("-d", "--decrypt") || sub === "decrypt")) {
    return deny(
      "Decrypting a secrets file puts its values in the conversation. The user edits it with `sops <file>`.",
    );
  }
  // A new dependency is code from outside: the user picks it (and Renovate waits 3 days
  // for any release; bunfig.toml makes `bun add` wait too).
  if ((program === "bun" && sub === "add") || (program === "uv" && sub === "add")) {
    return ask("Adding a dependency brings in outside code; the user decides.");
  }
  // Without the workspace's copy, bunx downloads whatever npm package has that name, and
  // runs it: `bunx biome` before `bun install` is someone else's "biome".
  if (program === "bunx" && sub && !sub.startsWith("-") && !installed(sub)) {
    return ask(
      `${sub} isn't installed here, so bunx would download and run npm's "${sub}". Run \`bun install\` first.`,
    );
  }
  if (program === "wt") {
    const wt = worktrunkVerdict(sub, third, has);
    if (wt) return wt;
  }
  if (program === "tofu" && ["apply", "destroy", "import", "state"].includes(sub)) {
    return ask("This changes real infrastructure or its state.");
  }
  const script = program === "bun" && sub === "run" ? third : program === "bun" ? sub : "";
  const destructive: Record<string, string> = {
    promote: "Opens a production promotion: a branch, a commit, a push and a pull request.",
    "scripts/release.ts": "Releases and promotes: pushes to GitHub.",
    "docker:clean": "Deletes every local volume (databases included).",
    "scripts/docker-clean.ts": "Deletes every local volume (databases included).",
    "k8s:down": "Deletes the local cluster.",
    "db:reset": "Resets the local database.",
  };
  if (destructive[script]) return ask(destructive[script] as string);
  if (
    program === "bun" &&
    words.includes("reset") &&
    words.some((word) => word.includes("@repo/db"))
  ) {
    return ask("Resets the local database (prisma migrate reset).");
  }
  if (
    program === "bunx" &&
    sub === "prisma" &&
    ["db", "migrate"].includes(third) &&
    has("push", "execute", "reset")
  ) {
    return ask("This changes or wipes the database outside a migration.");
  }
  return null;
}

/** The strictest verdict any command on the line gets (deny beats ask). */
export function commandPolicy(line: string, installed = installedBin): Verdict {
  const verdicts = simpleCommands(line)
    .map((command) => commandVerdict(command, installed))
    .filter((verdict) => verdict !== null);
  return verdicts.find((verdict) => verdict.decision === "deny") ?? verdicts[0] ?? null;
}
