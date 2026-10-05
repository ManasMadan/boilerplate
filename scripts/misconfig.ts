/**
 * Misconfigurations in the infrastructure code (Dockerfiles, Kubernetes manifests, Helm
 * charts, OpenTofu): `bun scripts/misconfig.ts`, the Security workflow's "Infrastructure
 * misconfigurations" job run locally, which the pre-commit hook runs when a staged file
 * is one it reads. Trivy's `config` scan of the whole repository with trivy.yaml (its
 * checks, the reviewed findings in .trivyignore.yaml, the trusted registries), at CI's
 * Trivy version: a local trivy of that version, else its image in Docker; with neither,
 * it fails and says how to get one, rather than skipping the scan. The whole repository,
 * not only the staged files: Trivy names a file scanned on its own by its bare name, so
 * the ignore file's paths wouldn't match, and the scan takes about two seconds.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fail, ROOT, runMain, runSync } from "./lib";

// renovate: datasource=docker depName=aquasec/trivy
export const TRIVY_VERSION = "0.74.0";

/** Whether the scan reads `path` (a path from the repository root). */
export const misconfigReads = (path: string) =>
  /(^|\/)[^/]*Dockerfile$/.test(path) ||
  /^(deploy|infra)\//.test(path) ||
  path === "trivy.yaml" ||
  path === ".trivyignore.yaml";

/** Scans the repository at `root`; the exit code (1 on any finding, from trivy.yaml). */
export function misconfig(
  run = runSync,
  root = ROOT,
  // Its own cache, which never holds a downloaded checks bundle (trivy.yaml skips the
  // update), so it uses the checks built into this version, as CI's fresh runner does.
  cache = join(homedir(), ".cache/boilerplate/trivy"),
): number {
  const scan = ["config", "--quiet", "."];
  let command: [string, string[]];
  if (run("trivy", ["--version"], { cwd: root }).stdout.includes(`Version: ${TRIVY_VERSION}\n`)) {
    command = ["trivy", [...scan, "--cache-dir", cache]];
  } else if (run("docker", ["info"], { cwd: root, stdio: "ignore" }).status === 0) {
    command = [
      "docker",
      [
        "run",
        "--rm",
        "--memory=512m",
        "-v",
        `${root}:${root}:ro`,
        "-w",
        root,
        `aquasec/trivy:${TRIVY_VERSION}`,
        ...scan,
      ],
    ];
  } else {
    fail(
      `Trivy ${TRIVY_VERSION} isn't installed and Docker isn't running: install that version (https://github.com/aquasecurity/trivy/releases) or start Docker`,
    );
    return 1;
  }
  return run(command[0], command[1], { cwd: root, stdio: "inherit" }).status ?? 1;
}

await runMain(import.meta, misconfig);
