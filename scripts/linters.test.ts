import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "./lib";
import { STEPS } from "./lint";
import { LINTERS, lint } from "./linters";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

/** A checkout with these files, and a `git ls-files` that lists them and one deleted. */
function checkout(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), "linters-"));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  const listed = { stdout: [...files, "deleted.yml"].join("\0") };
  return { root, listed };
}

const { actionlint, zizmor } = LINTERS;

describe("the pinned linters", () => {
  it("run a local binary of the pinned version over the files they read, and fail as it does", () => {
    const { root, listed } = checkout([".github/workflows/ci.yml", "README.md"]);
    const { run, calls } = fakeRun((line) => {
      if (line.startsWith("git ls-files")) {
        return listed;
      }
      if (line === "actionlint --version") {
        return { stdout: `${actionlint.version}\ninstalled from Homebrew\n` };
      }
      return line.startsWith("actionlint .github") ? { status: 1 } : {};
    });
    expect(lint(["actionlint"], run, root)).toBe(1);
    expect(calls).toEqual([
      "git ls-files --cached --others --exclude-standard -z",
      "actionlint --version",
      "actionlint .github/workflows/ci.yml",
    ]);
  });

  it("run the pinned image when the local binary is another version, or missing", () => {
    const { root, listed } = checkout([".github/workflows/ci.yml", ".github/zizmor.yml"]);
    for (const local of [{ stdout: "zizmor 0.1.0\n" }, { status: null }]) {
      const { run, calls } = fakeRun((line) => {
        if (line.startsWith("git ls-files")) {
          return listed;
        }
        return line === "zizmor --version" ? local : {};
      });
      expect(lint(["zizmor"], run, root)).toBe(0);
      expect(calls.at(-1)).toBe(
        `docker run --rm --memory=512m -v ${root}:${root}:ro -w ${root} --entrypoint zizmor ghcr.io/zizmorcore/zizmor:${zizmor.version} --offline --config=.github/zizmor.yml .github`,
      );
    }
  });

  it("fail rather than skipping when there's neither, or the linter can't start", () => {
    const { root, listed } = checkout([".github/workflows/ci.yml"]);
    const printed = captureOutput();
    const neither = fakeRun((line) => (line.startsWith("git ls-files") ? listed : { status: 1 }));
    expect(lint(["actionlint"], neither.run, root)).toBe(1);
    expect(printed()).toContain(
      `actionlint ${actionlint.version} isn't installed and Docker isn't running`,
    );
    const broken = fakeRun((line) => {
      if (line.startsWith("git ls-files")) {
        return listed;
      }
      return line.startsWith("docker run") ? { status: null } : {};
    });
    expect(lint(["actionlint"], broken.run, root)).toBe(1);
  });

  it("pass with nothing to check, and name the linters when given another", () => {
    const printed = captureOutput();
    const { root, listed } = checkout(["README.md"]);
    const { run, calls } = fakeRun(() => listed);
    expect(lint(["actionlint"], run, root)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(lint(["eslint"], run, root)).toBe(1);
    expect(printed()).toContain(`One of ${Object.keys(LINTERS).join(", ")}.`);
  });

  it("read what each checks", () => {
    expect(actionlint.reads(".github/workflows/ci.yml")).toBe(true);
    expect(actionlint.reads(".github/actions/setup/action.yml")).toBe(false);
    expect(zizmor.reads(".github/actions/setup/action.yml")).toBe(true);
    expect(zizmor.reads("deploy/charts/stack/values.yaml")).toBe(false);
  });

  it("are each a `bun run lint:<name>` script, and a step of `bun run lint`", () => {
    const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const steps = STEPS.map((step) => step.join(" "));
    for (const name of Object.keys(LINTERS)) {
      expect(scripts[`lint:${name}`]).toBe(`bun scripts/linters.ts ${name}`);
      expect(steps).toContain(`bun run lint:${name}`);
    }
  });
});
