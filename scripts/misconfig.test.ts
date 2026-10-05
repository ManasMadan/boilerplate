import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationRenders, environments } from "./charts";
import { type Ran, ROOT } from "./lib";
import { misconfig, misconfigReads, RENDERED, renderCharts, TRIVY_VERSION } from "./misconfig";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

/** A checkout with these environments, as applicationRenders reads it. */
function checkout(...environments: string[]) {
  const root = mkdtempSync(join(tmpdir(), "misconfig-"));
  mkdirSync(join(root, "deploy/environments"), { recursive: true });
  for (const env of environments) {
    mkdirSync(join(root, "deploy/environments", env), { recursive: true });
  }
  return root;
}

/** helm renders each chart as `rendered <name>`, and trivy answers with `trivy`. */
function tools(trivy: (line: string) => Partial<Ran> | undefined) {
  return fakeRun((line) => {
    const name = /^helm template (\S+) \S+\/(\w+) /.exec(line);
    return name ? { stdout: `rendered ${name[1]}-${name[2]}\n` } : trivy(line);
  });
}

describe("the misconfiguration scan", () => {
  it("renders every application chart, then scans with a local trivy of CI's version", () => {
    const root = checkout("production");
    const { run, calls, options } = tools((line) => {
      if (line === "trivy --version") {
        return { stdout: `Version: ${TRIVY_VERSION}\n` };
      }
      return line.startsWith("trivy config") ? { status: 1 } : undefined;
    });
    expect(misconfig(["--format", "sarif"], run, root, "/cache")).toBe(1);
    expect(calls.filter((line) => line.startsWith("helm template"))).toHaveLength(
      applicationRenders(root).length,
    );
    expect(calls.slice(-2)).toEqual([
      "trivy --version",
      "trivy config --quiet --format sarif . --cache-dir /cache",
    ]);
    expect(options.at(-1)).toEqual({ cwd: root, stdio: "inherit" });
    expect(readFileSync(join(root, RENDERED, "production-data.yaml"), "utf8")).toBe(
      "rendered production-data\n",
    );
  });

  it("starts from an empty folder of renders, so a removed one doesn't linger", () => {
    const root = checkout("production");
    mkdirSync(join(root, RENDERED), { recursive: true });
    writeFileSync(join(root, RENDERED, "gone.yaml"), "old");
    expect(renderCharts(tools(() => undefined).run, root)).toBe(true);
    expect(readdirSync(join(root, RENDERED))).not.toContain("gone.yaml");
  });

  it("runs its image when the local trivy is another version, or missing", () => {
    const root = checkout();
    for (const local of [{ stdout: "Version: 0.1.0\n" }, { status: null }]) {
      const { run, calls } = fakeRun((line) => (line === "trivy --version" ? local : {}));
      expect(misconfig([], run, root)).toBe(0);
      expect(calls.at(-1)).toBe(
        `docker run --rm --memory=512m -v ${root}:${root} -w ${root} aquasec/trivy:${TRIVY_VERSION} config --quiet .`,
      );
    }
  });

  it("fails rather than skipping when there's neither, and when trivy can't start", () => {
    const printed = captureOutput();
    const root = checkout();
    expect(misconfig([], tools(() => ({ status: 1 })).run, root)).toBe(1);
    expect(printed()).toContain("isn't installed and Docker isn't running");
    const { run } = fakeRun((line) => (line.startsWith("docker run") ? { status: null } : {}));
    expect(misconfig([], run, root)).toBe(1);
  });

  it("fails without helm, or when a chart doesn't render, scanning nothing", () => {
    const printed = captureOutput();
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const root = checkout("production");
    const missing = fakeRun((line) => (line.startsWith("helm") ? { status: null } : {}));
    expect(misconfig([], missing.run, root)).toBe(1);
    expect(printed()).toContain("helm isn't installed");
    const broken = fakeRun((line) =>
      line.startsWith("helm") ? { status: 1, stderr: "image.tag is required" } : {},
    );
    expect(misconfig([], broken.run, root)).toBe(1);
    expect(stderr).toHaveBeenCalledWith("image.tag is required");
    expect(printed()).toContain("helm couldn't render production-data");
    expect(broken.calls.some((line) => line.startsWith("trivy"))).toBe(false);
  });

  it("refuses an environment it doesn't know how to render", () => {
    expect(() => applicationRenders(checkout("qa"))).toThrow(
      "qa: add it to RELEASE_VALUES in scripts/charts.ts",
    );
  });

  // A chart added under deploy/charts must be rendered for the scan too: Trivy alone
  // skips any chart that needs values to render.
  it("renders every chart under deploy/charts, for every environment", () => {
    const charts = readdirSync(join(ROOT, "deploy/charts"));
    const renders = applicationRenders(ROOT).map((render) => render.args[2]);
    for (const chart of charts) {
      for (const env of environments(ROOT)) {
        expect(applicationRenders(ROOT).map((render) => render.name)).toContain(`${env}-${chart}`);
      }
      expect(renders).toContain(join(ROOT, "deploy/charts", chart));
    }
  });

  it.each([
    ["deploy/docker/web.Dockerfile", true],
    [".devcontainer/Dockerfile", true],
    ["deploy/platform/jaeger/values.yaml", true],
    ["infra/tofu/envs/k3s/main.tf", true],
    ["trivy.yaml", true],
    ["scripts/charts.ts", true],
    [".trivyignore.yaml", true],
    ["apps/api/src/main.ts", false],
    ["docs/deploy.md", false],
  ])("reads %s: %p", (path, reads) => {
    expect(misconfigReads(path)).toBe(reads);
  });

  it("is CI's scan: this script, at the same Trivy, with trivy.yaml deciding the rest", () => {
    const security = readFileSync(join(ROOT, ".github/workflows/security.yml"), "utf8");
    const job = security.slice(
      security.indexOf("  misconfig:"),
      security.indexOf("  security-ok:"),
    );
    expect(job).toContain(`version: v${TRIVY_VERSION}\n`);
    expect(job).toContain(
      "run: bun scripts/misconfig.ts --format sarif --output trivy-config.sarif\n",
    );
    for (const input of [
      "exit-code:",
      "skip-dirs:",
      "severity:",
      "trivyignores:",
      "trivy-action",
    ]) {
      expect(job).not.toContain(input);
    }
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain(`TRIVY: aquasec/trivy:${TRIVY_VERSION}\n`);
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8")).toContain(`\n${RENDERED}/\n`);
  });
});
