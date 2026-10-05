import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Area } from "./changes";
import { PLACEHOLDER, type Ran, ROOT } from "./lib";
import {
  allowedLicense,
  BOOKKEEPING,
  CI_ONLY,
  type Context,
  codeqlLanguages,
  jobEnv,
  licenseOf,
  limits,
  lockedPackages,
  MACHINE,
  prePush,
  type Result,
  STEPS,
  type Step,
  schedule,
  skips,
  spawnExec,
  workflow,
} from "./pre-push";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const GB = 1024 ** 3;
const none: Record<Area, boolean> = {
  app: false,
  charts: false,
  infra: false,
  images: false,
  scripts: false,
};

/** A step's context whose commands are recorded, answered by `answer`. */
function context(
  answer: (line: string) => Partial<Ran> | undefined = () => undefined,
  given: Partial<Context> = {},
) {
  const { run, calls, options } = fakeRun(answer);
  const logs: string[] = [];
  const closed: string[] = [];
  const ctx: Context = {
    root: ROOT,
    base: "abc",
    files: [],
    areas: { ...none, app: true },
    breaking: undefined,
    suites: 3,
    clamd: async () => ({
      url: "tcp://127.0.0.1:9",
      close: async () => {
        closed.push("clamd");
      },
    }),
    exec: async (command, args, options = {}) => run(command, args, options),
    log: (text) => logs.push(text),
    ...given,
  };
  return { ctx, calls, options, closed, logged: () => logs.join("") };
}

const step = (name: string) => {
  const found = STEPS.find((s) => s.name === name);
  if (!found) {
    throw new Error(`no step ${name}`);
  }
  return found;
};

describe("every CI job that can block a pull request", () => {
  const dir = join(ROOT, ".github/workflows");
  const gating = readdirSync(dir).filter((file) => {
    const { on } = Bun.YAML.parse(readFileSync(join(dir, file), "utf8")) as { on: object };
    return "pull_request" in on || "merge_group" in on;
  });
  const jobs = gating.flatMap((file) =>
    Object.keys(workflow(file).jobs).map((job) => `${file}:${job}`),
  );
  const mirrored = new Set(STEPS.flatMap((s) => s.jobs));

  it("has a pre-push step, or a reason in CI_ONLY why only CI runs it", () => {
    expect(jobs.length).toBeGreaterThan(20);
    const undecided = jobs.filter(
      (job) => !mirrored.has(job) && !(job in CI_ONLY) && !BOOKKEEPING.has(job),
    );
    expect(undecided).toEqual([]);
  });

  it("is named only as it exists, and either mirrored or CI-only, never both", () => {
    const named = [...mirrored, ...Object.keys(CI_ONLY), ...BOOKKEEPING];
    expect(named.filter((job) => !jobs.includes(job))).toEqual([]);
    expect(Object.keys(CI_ONLY).filter((job) => mirrored.has(job) || BOOKKEEPING.has(job))).toEqual(
      [],
    );
    expect(Object.values(CI_ONLY).every((reason) => reason.length > 20)).toBe(true);
  });
});

describe("the steps", () => {
  it("have distinct names, and need only steps listed before them", () => {
    const names = STEPS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [index, s] of STEPS.entries()) {
      for (const need of s.needs ?? []) {
        expect(names.slice(0, index)).toContain(need);
      }
    }
  });

  it("run the package scripts CI's jobs run", async () => {
    const expected: Record<string, string[]> = {
      "python dependencies": ["uv sync --locked"],
      services: [
        "bun scripts/services.ts up",
        "docker compose --profile files up -d --wait rustfs",
      ],
      secrets: ["bun scripts/secret-scan.ts --range=abc..HEAD"],
      "migration safety": ["bun run db:lint"],
      charts: ["bun run charts:check"],
      coverage: ["bun scripts/push-coverage.ts --concurrency=3"],
      lint: ["bun run lint"],
      types: ["bun run check-types"],
      "type coverage": ["bun run type-coverage"],
      codeql: ["bun run codeql --languages javascript-typescript,python"],
      generators: ["bun scripts/generators.ts"],
      evals: ["uv run python -m evals"],
      screenshots: ["bun run --cwd packages/ui test:visual"],
    };
    for (const [name, commands] of Object.entries(expected)) {
      const { ctx, calls } = context(undefined, { files: ["a.ts", "b.py"] });
      expect(await step(name).run(ctx)).toBe(true);
      expect({ name, calls }).toEqual({ name, calls: commands });
    }
  });

  it("fail when their command does", async () => {
    for (const name of ["python dependencies", "services", "evals"]) {
      const { ctx } = context(() => ({ status: 1 }));
      expect(await step(name).run(ctx)).toBe(false);
    }
  });

  it("skip CodeQL and the license check when nothing they read changed", () => {
    expect(step("codeql").skip?.(["README.md"])).toBe("no code CodeQL reads changed");
    expect(step("dependency licenses").skip?.(["package.json"])).toBe("no npm dependency changed");
    expect(step("dependency licenses").skip?.(["bun.lock"])).toBeUndefined();
  });
});

describe("the generated code check", () => {
  it("passes when `bun run gen` changes nothing", async () => {
    const { ctx, calls } = context();
    expect(await step("generated code").run(ctx)).toBe(true);
    expect(calls).toContain("bun run gen");
  });

  it("fails when gen fails, or changes or adds a file", async () => {
    expect(
      await step("generated code").run(
        context((l) => (l === "bun run gen" ? { status: 1 } : undefined)).ctx,
      ),
    ).toBe(false);
    let statuses = 0;
    const { ctx, logged } = context((line) =>
      line.startsWith("git status --porcelain")
        ? { stdout: statuses++ ? "?? new.ts\n" : "" }
        : undefined,
    );
    expect(await step("generated code").run(ctx)).toBe(false);
    expect(logged()).toContain("Generated files are out of date");
  });
});

describe("API compatibility", () => {
  const image = jobEnv("ci.yml", "api-compat").OASDIFF;

  it("diffs both documents against the push's base with CI's oasdiff, then the events", async () => {
    const { ctx, calls, logged } = context((line) =>
      line === "git show abc:apps/api/openapi.json" ? { status: 128 } : { stdout: "{}" },
    );
    expect(await step("API compatibility").run(ctx)).toBe(true);
    expect(logged()).toContain("The base has no apps/api/openapi.json yet.");
    const docker = calls.filter((c) => c.startsWith("docker"));
    expect(docker).toHaveLength(1);
    expect(docker[0]).toContain(`${image} breaking /base/ai.json /head/openapi.json --fail-on ERR`);
    expect(calls.at(-1)).toBe("bun scripts/events-compat.ts abc");
  });

  it("fails on a breaking change, unless a commit declares one", async () => {
    const breaking = (line: string) =>
      line.startsWith("docker") || line.startsWith("bun") ? { status: 1 } : undefined;
    expect(await step("API compatibility").run(context(breaking).ctx)).toBe(false);
    const declared = context(breaking, { breaking: "feat(api)!: drop the v1 todos" });
    expect(await step("API compatibility").run(declared.ctx)).toBe(false);
    const eventsOnly = context((l) => (l.startsWith("bun") ? { status: 1 } : undefined), {
      breaking: "feat(api)!: drop the v1 todos",
    });
    expect(await step("API compatibility").run(eventsOnly.ctx)).toBe(true);
    expect(eventsOnly.logged()).toContain("declares a breaking change");
    expect(eventsOnly.calls.find((c) => c.startsWith("docker"))).not.toContain("--fail-on");
  });
});

describe("the infra check", () => {
  it("needs a local tofu", async () => {
    const { ctx, calls, logged } = context(() => ({ status: -2 }));
    expect(await step("infra").run(ctx)).toBe(false);
    expect(calls).toEqual(["tofu version"]);
    expect(logged()).toContain("OpenTofu isn't installed");
  });

  it("runs infra:check with it", async () => {
    const { ctx, calls } = context();
    expect(await step("infra").run(ctx)).toBe(true);
    expect(calls).toEqual(["tofu version", "bun run infra:check"]);
  });
});

describe("the database steps", () => {
  const database = `prepush_${process.pid}`;

  it("migrate a database of their own, check drift on it and drop it", async () => {
    const { ctx, calls, options } = context();
    expect(await step("migrations match the schema").run(ctx)).toBe(true);
    expect(calls[0]).toContain(
      `CREATE DATABASE ${database}_drift OWNER migrator TEMPLATE template0`,
    );
    expect(calls[1]).toContain("CREATE EXTENSION vector");
    expect(calls.slice(2, 4)).toEqual(["bun run db:deploy", "bun run --cwd packages/db drift"]);
    expect(calls[4]).toContain(`DROP DATABASE IF EXISTS ${database}_drift WITH (FORCE)`);
    const env = options[2]?.env ?? {};
    expect(env.MIGRATOR_DATABASE_URL).toBe(
      `postgresql://migrator:migrator@localhost:55432/${database}_drift`,
    );
    expect(env.AI_DATABASE_URL).toEndWith(`@localhost:55432/${database}_drift`);
    expect(env.SHADOW_DATABASE_URL).toEndWith("/app_shadow");
  });

  it("still drop it when creating it fails", async () => {
    const { ctx, calls } = context((line) =>
      line.includes("CREATE DATABASE") ? { status: 1 } : undefined,
    );
    expect(await step("migrations match the schema").run(ctx)).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("DROP DATABASE");
  });

  it("run the e2e suite as CI's job does: its environment, this machine's ports", async () => {
    const { ctx, calls, options, closed } = context();
    expect(await step("e2e").run(ctx)).toBe(true);
    expect(calls.slice(3, 6)).toEqual([
      "bun scripts/e2e.ts",
      "bun run --cwd apps/web budget",
      `bun run db:restore-drill ${database}_e2e`,
    ]);
    const env = options[3]?.env ?? {};
    expect(env.API_DATABASE_URL).toBe(
      `postgresql://app_api:app_api@localhost:55432/${database}_e2e`,
    );
    expect(env.REDIS_URL).toBe("redis://localhost:56379");
    expect(env.S3_BUCKET).toBe("uploads");
    expect(env.STRIPE_SECRET_KEY).toBe("sk_test_ci");
    expect(env.GOOGLE_CLIENT_ID).toBe("");
    expect(env.CLAMAV_URL).toBe("tcp://127.0.0.1:9");
    expect(env.NODE_ENV).toBe("test");
    expect(env.BETTER_AUTH_SECRET).not.toMatch(PLACEHOLDER);
    expect(closed).toEqual(["clamd"]);
  });

  it("stop the e2e run at its first failure, and close ClamAV's stand-in", async () => {
    const { ctx, calls, closed } = context((l) =>
      l === "bun scripts/e2e.ts" ? { status: 1 } : undefined,
    );
    expect(await step("e2e").run(ctx)).toBe(false);
    expect(calls.some((c) => c.includes("budget"))).toBe(false);
    expect(closed).toEqual(["clamd"]);
  });
});

describe("known vulnerabilities", () => {
  it("scans both lockfiles with security.yml's OSV image and config", async () => {
    const version = /osv-scanner-action@\w+ # (v\S+)/.exec(workflow("security.yml").text)?.[1];
    const { ctx, calls } = context();
    expect(await step("known vulnerabilities").run(ctx)).toBe(true);
    expect(calls[0]).toContain(`ghcr.io/google/osv-scanner-action:${version}`);
    expect(calls[0]).toEndWith(
      "--config=osv-scanner.toml --lockfile=bun.lock --lockfile=apps/ai/uv.lock",
    );
  });
});

describe("the new dependencies' licenses", () => {
  const lock = (...entries: string[]) =>
    `{\n  "workspaces": {\n    "": { "name": "x" },\n  },\n  "packages": {\n${entries.map((e) => `    ${e},\n`).join("")}  }\n}\n`;
  const pkg = (root: string, path: string, manifest: object) => {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), JSON.stringify(manifest));
  };

  it("reads what bun.lock installs, and where", () => {
    const text = lock(
      `"@repo/ui": ["@repo/ui@workspace:packages/ui"]`,
      `"zod": ["zod@4.0.0", "", {}, "sha"]`,
      `"next/postcss": ["postcss@8.4.31", "", {}, "sha"]`,
    );
    expect([...lockedPackages(text)]).toEqual([
      ["zod", "zod@4.0.0"],
      ["next/postcss", "postcss@8.4.31"],
    ]);
  });

  it("finds a package's license where it's installed", () => {
    const root = mkdtempSync(join(tmpdir(), "licenses-"));
    pkg(root, "node_modules/@s/a/node_modules/b", { license: "MIT" });
    pkg(root, "node_modules/old", { license: { type: "MIT" } });
    expect(licenseOf(root, "@s/a/b")).toBe("MIT");
    expect(licenseOf(root, "old")).toBeUndefined();
    expect(licenseOf(root, "missing")).toBeUndefined();
  });

  it("reads SPDX expressions", () => {
    const allowed = new Set(["MIT", "Apache-2.0"]);
    expect(allowedLicense("(MIT OR GPL-3.0)", allowed)).toBe(true);
    expect(allowedLicense("MIT AND Apache-2.0", allowed)).toBe(true);
    expect(allowedLicense("MIT AND GPL-3.0", allowed)).toBe(false);
  });

  it("fails on a new package whose license security.yml doesn't allow, and notes unknown ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "licenses-"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    copyFileSync(
      join(ROOT, ".github/workflows/security.yml"),
      join(root, ".github/workflows/security.yml"),
    );
    const before = lock(`"kept": ["kept@1.0.0", "", {}, "sha"]`);
    writeFileSync(
      join(root, "bun.lock"),
      lock(
        `"kept": ["kept@1.0.0", "", {}, "sha"]`,
        `"fine": ["fine@1.0.0", "", {}, "sha"]`,
        `"viral": ["viral@1.0.0", "", {}, "sha"]`,
        `"unknown": ["unknown@1.0.0", "", {}, "sha"]`,
      ),
    );
    pkg(root, "node_modules/fine", { license: "MIT" });
    pkg(root, "node_modules/viral", { license: "GPL-3.0-only" });
    const { ctx, logged } = context(
      (line) => (line.startsWith("git show") ? { stdout: before } : undefined),
      { root },
    );
    expect(await step("dependency licenses").run(ctx)).toBe(false);
    expect(logged()).toContain(
      "viral@1.0.0: GPL-3.0-only isn't among security.yml's allow-licenses",
    );
    expect(logged()).toContain("unknown@1.0.0 declares no license");
    expect(logged()).not.toContain("fine@");
  });
});

describe("what decides which steps run", () => {
  it("reads a job's plain environment from its workflow", () => {
    expect(jobEnv("ci.yml", "e2e").S3_BUCKET).toBe("uploads");
    const root = mkdtempSync(join(tmpdir(), "workflows-"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github/workflows/x.yml"),
      `jobs:\n  a:\n    env: { PLAIN: yes, SECRET: '$\{{ secrets.X }}', COUNT: 3 }\n  b: {}\n`,
    );
    expect(jobEnv("x.yml", "a", root)).toEqual({ PLAIN: "yes" });
    expect(jobEnv("x.yml", "b", root)).toEqual({});
    expect(jobEnv("x.yml", "missing", root)).toEqual({});
  });

  it("finds the CodeQL languages of the changed files", () => {
    expect(codeqlLanguages([".github/workflows/ci.yml", "a.py", "b.tsx", "README.md"])).toEqual([
      "actions",
      "javascript-typescript",
      "python",
    ]);
    expect(codeqlLanguages(["scripts/x.mjs"])).toEqual(["javascript-typescript"]);
  });

  it("skips a step whose areas the push leaves alone, or that PRE_PUSH_SKIP names", () => {
    const skipped = skips({ ...none, charts: true }, ["deploy/x.yaml"], "lint, charts");
    expect(skipped.get("charts")).toBe("PRE_PUSH_SKIP (CI still runs it)");
    expect(skipped.get("lint")).toBe("PRE_PUSH_SKIP (CI still runs it)");
    expect(skipped.get("coverage")).toBe("area untouched (app, scripts)");
    expect(skipped.get("codeql")).toBe("no code CodeQL reads changed");
    expect(skipped.has("secrets")).toBe(false);
    expect(skips(none, []).has("lint")).toBe(false);
  });

  it("sizes the run to the machine, unless told", () => {
    expect(limits({}, 10, 16 * GB)).toEqual({ slots: 9, memory: 14 });
    expect(limits({}, 1, 2 * GB)).toEqual({ slots: 1, memory: 2 });
    expect(limits({ PRE_PUSH_CONCURRENCY: "1", PRE_PUSH_MEMORY_GB: "6" }, 10, 16 * GB)).toEqual({
      slots: 1,
      memory: 6,
    });
    expect(limits({ PRE_PUSH_CONCURRENCY: "none" }, 4, 16 * GB).slots).toBe(3);
  });
});

describe("the scheduler", () => {
  const room = { slots: 8, memory: 10, docker: 2 };
  const make = (name: string, more: Partial<Step> = {}): Step => ({
    name,
    jobs: [],
    areas: [],
    memory: 1,
    run: async () => true,
    ...more,
  });

  /** Runs `steps`, failing those in `failing`; who ran beside whom, and the results. */
  async function run(
    steps: Step[],
    given = room,
    failing: string[] = [],
    skipped = new Map<string, string>(),
  ) {
    const active = new Set<string>();
    const together: string[][] = [];
    const aborted: string[] = [];
    const results = await schedule(steps, skipped, given, async (s, signal) => {
      active.add(s.name);
      together.push([...active].sort());
      signal.addEventListener("abort", () => aborted.push(s.name));
      await Bun.sleep(s.name.startsWith("slow") ? 30 : 5);
      active.delete(s.name);
      return !failing.includes(s.name);
    });
    return {
      together,
      aborted,
      results: Object.fromEntries(results.map((r: Result) => [r.name, r.status])),
    };
  }

  it("starts a step once what it needs has passed", async () => {
    const { together, results } = await run([make("a"), make("b", { needs: ["a"] }), make("c")]);
    expect(together.slice(0, 2)).toEqual([["a"], ["a", "c"]]);
    expect(together.find((t) => t.includes("b"))).not.toContain("a");
    expect(results).toEqual({ a: "passed", b: "passed", c: "passed" });
  });

  it("runs one lane's steps one at a time, and no more than the slots", async () => {
    const lane = await run([
      make("a", { lane: "valkey" }),
      make("b", { lane: "valkey" }),
      make("c"),
    ]);
    expect(lane.together.some((t) => t.includes("a") && t.includes("b"))).toBe(false);
    const serial = await run([make("a"), make("b"), make("c")], { ...room, slots: 1 });
    expect(serial.together.every((t) => t.length === 1)).toBe(true);
  });

  it("keeps to the memory, and Docker's, but always runs a step on its own", async () => {
    const memory = await run([
      make("big", { memory: 20 }),
      make("x", { memory: 6 }),
      make("y", { memory: 6 }),
    ]);
    expect(memory.together.every((t) => t.length === 1 || !t.includes("big"))).toBe(true);
    expect(memory.together.some((t) => t.includes("x") && t.includes("y"))).toBe(false);
    const docker = await run([
      make("p", { docker: 1.5 }),
      make("q", { docker: 1 }),
      make("r", { docker: 0.25 }),
    ]);
    expect(docker.together.some((t) => t.includes("p") && t.includes("q"))).toBe(false);
    expect(docker.together.some((t) => t.includes("p") && t.includes("r"))).toBe(true);
  });

  it("stops everything at the first failure, but lets a kept step finish", async () => {
    const { results, aborted } = await run(
      [
        make("fails"),
        make("slow"),
        make("slow kept", { keep: true }),
        make("after", { needs: ["fails"] }),
      ],
      room,
      ["fails", "slow"],
    );
    expect(results).toEqual({
      fails: "failed",
      slow: "stopped",
      "slow kept": "passed",
      after: "stopped",
    });
    expect(aborted).toEqual(["slow"]);
  });

  it("reports what it skipped, and stops when nothing can start", async () => {
    const { results } = await run(
      [make("a", { needs: ["nowhere"] }), make("b")],
      room,
      [],
      new Map([["b", "area untouched (app)"]]),
    );
    expect(results).toEqual({ a: "stopped", b: "skipped" });
  });
});

describe("the commands a step runs", () => {
  it("keeps their output, quiet or not, and their exit code", async () => {
    const logged: string[] = [];
    const exec = spawnExec(new AbortController().signal, (text) => logged.push(text));
    expect(await exec("sh", ["-c", "echo out; echo err >&2; exit 3"])).toEqual({
      status: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
    expect((await exec("sh", ["-c", "echo $X"], { env: { X: "set" }, quiet: true })).stdout).toBe(
      "set\n",
    );
    expect(logged.join("")).toBe("out\nerr\n");
  });

  it("says when a command doesn't exist", async () => {
    const exec = spawnExec(new AbortController().signal, () => undefined);
    const ran = await exec("no-such-command-anywhere", [], { cwd: tmpdir() });
    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("no-such-command-anywhere");
  });

  it("stops the command and what it started when the step is stopped", async () => {
    const controller = new AbortController();
    const exec = spawnExec(controller.signal, () => undefined);
    const started = Date.now();
    const ran = exec("sh", ["-c", "sleep 20 & sleep 20"]);
    setTimeout(() => controller.abort(), 50);
    expect((await ran).status).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    controller.abort();
  });
});

describe("the hook", () => {
  /** A machine where the push changes `files` since abc; `answer` for everything else. */
  function machine(
    files: string[],
    answer: (line: string) => Partial<Ran> | undefined = () => undefined,
    git: Record<string, string> = {},
  ) {
    const answers: [RegExp, Partial<Ran>][] = [
      [/^git merge-base/, { stdout: "abc\n" }],
      [/^git diff --name-only/, { stdout: files.join("\n") }],
      [/^docker info/, { stdout: String(4 * GB) }],
      [/^docker stats/, { stdout: "postgres\t512MiB / 1GiB\n" }],
      [/^git (\S+)/, {}],
    ];
    const fake = fakeRun((line) => {
      const [, found] = answers.find(([pattern]) => pattern.test(line)) ?? [];
      const word = /^git (\S+)/.exec(line)?.[1] ?? "";
      return answer(line) ?? (found && { ...found, stdout: found.stdout ?? git[word] ?? "" });
    });
    const given = {
      run: fake.run,
      exec:
        (_signal: AbortSignal, log: (text: string) => void) =>
        async (command: string, args: string[]) => {
          log(`${command} ran\n`);
          return fake.run(command, args);
        },
      clamd: async () => ({ url: "tcp://127.0.0.1:9", close: async () => undefined }),
      cpus: 4,
      memory: 16 * GB,
      env: {},
      onInterrupt: () => undefined,
    };
    return { given, calls: fake.calls };
  }

  it("runs every step the push's areas call for, and sums them up", async () => {
    const output = captureOutput();
    const { given, calls } = machine(["apps/api/src/main.ts"], undefined, {
      log: "fix(api): a thing\n",
    });
    expect(await prePush(given)).toBe(0);
    expect(calls).toContain("bun run lint");
    expect(calls).toContain("bun scripts/push-coverage.ts --concurrency=3");
    expect(calls).toContain("bun run codeql --languages javascript-typescript");
    expect(calls.some((c) => c.startsWith("bun run charts:check"))).toBe(false);
    expect(output()).toContain("Pre-push: 1 files changed since abc, up to 3 steps at once");
    expect(output()).toMatch(/charts {2,}skipped {2,}area untouched \(charts\)/);
    expect(output()).toContain(`ci.yml:images`);
    expect(output()).toContain("every check CI runs that can run here passed");
  });

  it("names the step that failed, prints its output, and warns about uncommitted changes", async () => {
    const output = captureOutput();
    const { given } = machine(
      ["README.md"],
      (l) => (l === "bun run lint" ? { status: 1 } : undefined),
      {
        status: " M README.md\n",
      },
    );
    expect(await prePush(given)).toBe(1);
    expect(output()).toContain("Uncommitted changes");
    expect(output()).toContain("bun ran");
    expect(output()).toContain("lint failed: fix it, or push with --no-verify");
  });

  it("refuses a step that needs more Docker memory than there is", async () => {
    const output = captureOutput();
    const { given } = machine(["README.md"], (l) =>
      l.startsWith("docker info") ? { status: 1, stdout: "" } : undefined,
    );
    expect(await prePush({ ...given, env: { PRE_PUSH_SKIP: "secrets" } })).toBe(1);
    expect(output()).toContain(
      "known vulnerabilities needs 0.5 GB of Docker memory, and Docker has 0.0 GB free",
    );
  });

  it("stops everything when interrupted", async () => {
    captureOutput();
    const { given } = machine(["README.md"]);
    let stop = () => undefined as unknown;
    const exec =
      (signal: AbortSignal, log: (text: string) => void) =>
      async (command: string, args: string[]) => {
        stop();
        return signal.aborted
          ? { status: null, stdout: "", stderr: "" }
          : given.exec(signal, log)(command, args);
      };
    const onInterrupt = (handler: () => void) => {
      stop = handler;
    };
    expect(await prePush({ ...given, exec, onInterrupt })).toBe(130);
  });

  it("reports a step that throws as failed", async () => {
    const output = captureOutput();
    const { given } = machine(["README.md"]);
    const exec = () => async () => {
      throw new Error("spawn exploded");
    };
    expect(await prePush({ ...given, exec })).toBe(1);
    expect(output()).toContain("spawn exploded");
  });

  it("stops when git can't tell what the push changes", async () => {
    const output = captureOutput();
    const { given } = machine([], (l) =>
      l.startsWith("git diff --name-only") ? { status: 128, stderr: "bad base" } : undefined,
    );
    expect(await prePush(given)).toBe(1);
    expect(output()).toContain("git diff against abc failed: bad base");
  });

  it("listens for Ctrl-C", () => {
    const stop = () => undefined;
    MACHINE.onInterrupt(stop);
    expect(process.listeners("SIGINT")).toContain(stop);
    process.removeListener("SIGINT", stop);
  });
});
