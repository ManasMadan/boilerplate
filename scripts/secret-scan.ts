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
  command = [
    "docker",
    [
      "run",
      "--rm",
      "--memory=256m",
      "-v",
      `${ROOT}:/repo`,
      "-w",
      "/repo",
      `ghcr.io/gitleaks/gitleaks:${VERSION}`,
      ...ARGS,
      "/repo",
    ],
  ];
} else {
  fail(
    "gitleaks isn't installed and Docker isn't running: install gitleaks (`brew install gitleaks`) or start Docker",
  );
  process.exit(1);
}
const scan = spawnSync(command[0], command[1], { cwd: ROOT, stdio: "inherit" });
process.exit(scan.status ?? 1);
