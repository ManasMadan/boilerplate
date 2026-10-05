/**
 * Misconfigurations in the infrastructure code (Dockerfiles, Kubernetes manifests, Helm
 * charts, OpenTofu): `bun scripts/misconfig.ts`, the Security workflow's "Infrastructure
 * misconfigurations" job (which passes `--format sarif --output <file>`, handed on to
 * Trivy), and the pre-commit hook when a staged file is one it reads.
 *
 * First it renders the application charts the way `bun run charts:check` does (every
 * environment and optional feature, scripts/charts.ts) into deploy/.rendered: Trivy can't
 * render them itself, since they need values an environment sets, and it skipped them.
 * Then Trivy's `config` scan of the whole repository with trivy.yaml (its checks, the
 * reviewed findings in .trivyignore.yaml, the trusted registries), at CI's Trivy version:
 * a local trivy of that version, else its image in Docker; with neither, or without helm,
 * it fails and says how to get one, rather than skipping the scan. The whole repository,
 * not only the staged files: Trivy names a file scanned on its own by its bare name, so
 * the ignore file's paths wouldn't match, and the scan takes a few seconds.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applicationRenders } from "./charts";
import { fail, ROOT, type Run, runMain, runSync } from "./lib";

/** Where the rendered charts go for the scan (git ignores it). */
export const RENDERED = "deploy/.rendered";

// renovate: datasource=docker depName=aquasec/trivy
export const TRIVY_VERSION = "0.74.0";

/** Whether the scan reads `path` (a path from the repository root). */
export const misconfigReads = (path: string) =>
  /(^|\/)[^/]*Dockerfile$/.test(path) ||
  /^(deploy|infra)\//.test(path) ||
  path === "scripts/charts.ts" ||
  path === "trivy.yaml" ||
  path === ".trivyignore.yaml";

/** Renders every application chart into RENDERED; whether all of them rendered. */
export function renderCharts(run: Run, root: string): boolean {
  const dir = join(root, RENDERED);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const { name, args } of applicationRenders(root)) {
    const rendered = run("helm", args, { cwd: root });
    if (rendered.status === null) {
      fail("helm isn't installed: install it (https://helm.sh/docs/intro/install/)");
      return false;
    }
    if (rendered.status !== 0) {
      process.stderr.write(rendered.stderr);
      fail(`helm couldn't render ${name} (above)`);
      return false;
    }
    writeFileSync(join(dir, `${name}.yaml`), rendered.stdout);
  }
  return true;
}

/** Scans the repository at `root`; the exit code (1 on any finding, from trivy.yaml). */
export function misconfig(
  argv = process.argv.slice(2),
  run = runSync,
  root = ROOT,
  // Its own cache, which never holds a downloaded checks bundle (trivy.yaml skips the
  // update), so it uses the checks built into this version, as CI's fresh runner does.
  cache = join(homedir(), ".cache/boilerplate/trivy"),
): number {
  if (!renderCharts(run, root)) {
    return 1;
  }
  const scan = ["config", "--quiet", ...argv, "."];
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
        // Writable: an --output file lands in the checkout.
        "-v",
        `${root}:${root}`,
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
