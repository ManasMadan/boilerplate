/**
 * Secrets in the staged changes (the pre-commit hook), with gitleaks and the reviewed
 * findings in .gitleaksignore, so a key never reaches history; CI scans again. Uses a
 * local gitleaks, or its container when Docker is running; with neither, the commit
 * stops and says how to get one, rather than skipping the scan.
 */
import { spawnSync } from "node:child_process";
import { fail, ROOT } from "./lib";

// renovate: datasource=github-releases depName=gitleaks/gitleaks
const VERSION = "v8.28.0";
const ARGS = [
  "git",
  "--pre-commit",
  "--staged",
  "--redact",
  "--verbose",
  "--no-banner",
  "--log-level=error",
];

const has = (command: string, args: string[]) =>
  spawnSync(command, args, { cwd: ROOT, stdio: "ignore" }).status === 0;

let command: [string, string[]];
if (has("gitleaks", ["version"])) {
  command = ["gitleaks", [...ARGS, "."]];
} else if (has("docker", ["info"])) {
  // Mounted at their own paths: in a git worktree, .git is a file naming the main
  // repository's git directory by absolute path, which must resolve in the container too.
  const gitDir = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  const mounts = [ROOT, ...(gitDir.startsWith(`${ROOT}/`) ? [] : [gitDir])].flatMap((path) => [
    "-v",
    `${path}:${path}`,
  ]);
  command = [
    "docker",
    [
      "run",
      "--rm",
      "--memory=256m",
      ...mounts,
      "-w",
      ROOT,
      `ghcr.io/gitleaks/gitleaks:${VERSION}`,
      ...ARGS,
      ROOT,
    ],
  ];
} else {
  fail(
    "gitleaks isn't installed and Docker isn't running: install gitleaks (`brew install gitleaks`) or start Docker",
  );
  process.exit(1);
}
const scan = spawnSync(command[0], command[1], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "pipe"],
  encoding: "utf8",
});
process.stderr.write(scan.stderr ?? "");
// gitleaks exits 0 when git itself fails (it then scanned nothing): that's no pass.
if (scan.status === 0 && /\[git\] fatal/.test(scan.stderr ?? "")) {
  fail("gitleaks couldn't read the staged changes (git failed above), so nothing was scanned");
  process.exit(1);
}
process.exit(scan.status ?? 1);
