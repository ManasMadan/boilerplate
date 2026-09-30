/**
 * What the workflows in .github/workflows promise, read from the files themselves: who
 * gets which secrets, what runs when, and the rules every job follows (.claude/rules/ci.md).
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
  if?: string;
  environment?: string;
  env?: Record<string, string>;
  steps?: Step[];
  "timeout-minutes"?: number;
  uses?: string;
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

function workflow(name: string) {
  return Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows", name), "utf8")) as Workflow;
}

describe("infra.yml", () => {
  const { jobs } = workflow("infra.yml");
  const plan = jobs.plan as Job;
  const apply = jobs.apply as Job;

  it("plans pull requests in an environment of their own, never the apply one", () => {
    expect(plan.environment).toMatch(/^infra-\$\{\{ matrix\.env \}\}-plan$/);
    expect(plan.if).toContain("github.event_name == 'pull_request'");
    expect(apply.environment).toMatch(/^infra-\$\{\{ matrix\.env \}\}$/);
    expect(apply.if).toBe("github.event_name == 'workflow_dispatch'");
  });

  it("gives a pull request's plan no SSH key and no age keys", () => {
    const text = JSON.stringify(plan);
    for (const secret of ["SSH_PRIVATE_KEY", "SOPS_AGE_KEY", "SOPS_PREVIEW_AGE_KEY"]) {
      expect(text).not.toContain(`secrets.${secret}`);
    }
  });

  it("never plans a fork's pull request", () => {
    expect(plan.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("plans without taking the state lock, which read-only bucket keys can't", () => {
    const step = plan.steps?.find((s) => s.name === "Plan");
    expect(step?.run).toContain("-lock=false");
  });
});

describe("every workflow", () => {
  const files = readdirSync(join(ROOT, ".github/workflows")).filter((f) => f.endsWith(".yml"));

  it("gives every job a timeout, so a hung one doesn't burn six hours", () => {
    const missing = files.flatMap((file) =>
      Object.entries(workflow(file).jobs)
        .filter(([, job]) => job["timeout-minutes"] === undefined)
        .map(([name]) => `${file}: ${name}`),
    );
    expect(missing).toEqual([]);
  });
});

describe("deploy.yml", () => {
  const { jobs } = workflow("deploy.yml");
  const merge = jobs.publish?.steps?.find((step) => step.name === "Merge the architectures");

  it("signs with the key pair when there is one, so admission needn't trust Sigstore", () => {
    expect(merge?.run).toContain(
      "cosign sign --yes --key env://COSIGN_PRIVATE_KEY --tlog-upload=false",
    );
    expect(JSON.stringify(merge)).toContain("secrets.COSIGN_PRIVATE_KEY");
  });

  it("signs keylessly otherwise", () => {
    expect(merge?.run).toContain('cosign sign --yes "$REGISTRY/$image@$digest"');
  });
});

describe("the GitHub-only parts", () => {
  const table = readFileSync(join(ROOT, "docs/deploy.md"), "utf8");
  const workflows = readdirSync(join(ROOT, ".github/workflows"))
    .map((file) => readFileSync(join(ROOT, ".github/workflows", file), "utf8"))
    .join("\n");
  const previews = readFileSync(join(ROOT, "deploy/argocd/appsets/previews.yaml"), "utf8");

  // What each is called in the workflows, and in docs/deploy.md's table.
  const parts: [used: string, documented: string][] = [
    ["workflow_run:", "`workflow_run`"],
    ["merge_group:", "`merge_group`"],
    ["id-token: write", "OIDC keyless signing"],
    ["actions/attest-build-provenance", "`attest-build-provenance`"],
    ["github/codeql-action", "CodeQL"],
    ["actions/dependency-review-action", "dependency review"],
    ["ghcr.io", "GHCR"],
    ["actions/create-github-app-token", "the GitHub App"],
  ];

  it("are each in docs/deploy.md with what replaces them", () => {
    for (const [used, documented] of parts) {
      if (workflows.includes(used))
        expect({ used, documented: table.includes(documented) }).toEqual({
          used,
          documented: true,
        });
    }
    if (previews.includes("github:")) expect(table).toContain("`pullRequest.github`");
  });
});

describe("the merge queue", () => {
  // The checks the ruleset requires come from these (docs/repository-settings.md).
  it.each(["ci.yml", "security.yml"])("runs %s, so its required checks report there", (file) => {
    expect(Object.keys(workflow(file).on)).toContain("merge_group");
  });

  it("skips what the pull request's own run already did, which counts as passing", () => {
    const { jobs } = workflow("security.yml");
    expect(jobs.secrets?.if).toBe("github.event_name != 'merge_group'");
    expect(jobs.dependencies?.if).toBe("github.event_name == 'pull_request'");
    expect(jobs.osv?.if).toBeUndefined();
  });
});

describe("ci.yml's codegen check", () => {
  const step = workflow("ci.yml").jobs.codegen?.steps?.find(
    (s) => s.name === "Fail if generation changed or added files",
  );

  it("fails on new generated files too, not only on changed ones", () => {
    expect(step?.run).toContain('[[ -n "$(git status --porcelain)" ]]');
    expect(step?.run).not.toContain("git diff --exit-code");
  });
});

describe("deploy.yml's staging bump", () => {
  const { jobs } = workflow("deploy.yml");
  const script = jobs.staging?.steps?.find((s) => s.name === "Point staging at the new images")
    ?.run as string;

  /** A master with commits a (staging's), b and c, pushed to a local origin. */
  function repository() {
    const dir = mkdtempSync(join(tmpdir(), "staging-bump-"));
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: join(dir, "work") })
        .stdout.toString()
        .trim();
    Bun.spawnSync(["git", "init", "--bare", "-b", "master", join(dir, "origin")]);
    Bun.spawnSync(["git", "clone", join(dir, "origin"), join(dir, "work")]);
    git("config", "user.email", "ci@example.com");
    git("config", "user.name", "CI");
    const commit = (message: string) => {
      git("commit", "--allow-empty", "-qm", message);
      return git("rev-parse", "HEAD");
    };
    mkdirSync(join(dir, "work/deploy/environments/staging"), { recursive: true });
    const a = commit("a");
    writeFileSync(
      join(dir, "work/deploy/environments/staging/stack.yaml"),
      `image:\n  tag: "sha-${a}"\n`,
    );
    git("add", ".");
    const b = commit("b");
    const c = commit("c");
    git("push", "-q", "origin", "master");
    const bump = (tag: string) =>
      Bun.spawnSync(["bash", "-c", script], {
        cwd: join(dir, "work"),
        env: { ...process.env, TAG: tag },
      });
    const staging = () =>
      Bun.spawnSync([
        "git",
        "--git-dir",
        join(dir, "origin"),
        "show",
        "master:deploy/environments/staging/stack.yaml",
      ]).stdout.toString();
    return { a, b, c, bump, staging };
  }

  it("moves staging forward to a newer commit's images", () => {
    const repo = repository();
    expect(repo.bump(`sha-${repo.c}`).exitCode).toBe(0);
    expect(repo.staging()).toContain(`tag: "sha-${repo.c}"`);
  });

  it("never moves it back when an older commit's run finishes last", () => {
    const repo = repository();
    repo.bump(`sha-${repo.c}`);
    const late = repo.bump(`sha-${repo.b}`);
    expect(late.exitCode).toBe(0);
    expect(late.stdout.toString()).toContain("newer than");
    expect(repo.staging()).toContain(`tag: "sha-${repo.c}"`);
  });

  it("builds every commit's images: one run per commit, never cancelled", () => {
    const text = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");
    expect(text).toContain(
      `group: deploy-\${{ github.event.workflow_run.head_sha || github.sha }}`,
    );
  });
});

describe("ci.yml's path filters", () => {
  const { jobs } = workflow("ci.yml");
  const run = jobs["ci-ok"]?.steps?.[0]?.run as string;
  const program = /jq -e --arg event "\$EVENT" '([\s\S]*)' > \/dev\/null/.exec(run)?.[1] ?? "";
  const gates = JSON.parse(
    (/\{([^}]*)\} as \$gates/.exec(program)?.[1] ?? "")
      .replace(/([\w-]+):/g, '"$1":')
      .replace(/""/g, '"')
      .replace(/^/, "{")
      .concat("}"),
  ) as Record<string, string[]>;

  /** What ci-ok decides for these job results and areas. */
  function passes(event: string, areas: Record<string, string>, results: Record<string, string>) {
    const needs = {
      changes: { result: "success", outputs: areas },
      ...Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result }])),
    };
    return (
      Bun.spawnSync(["jq", "-e", "--arg", "event", event, program], {
        stdin: new TextEncoder().encode(JSON.stringify(needs)),
      }).exitCode === 0
    );
  }
  const areas = (on: string[]) =>
    Object.fromEntries(
      ["app", "charts", "infra", "images", "scripts"].map((a) => [a, String(on.includes(a))]),
    );
  const skipped = (names: string[]) => Object.fromEntries(names.map((n) => [n, "skipped"]));
  const heavy = Object.keys(gates);

  it("gates each job on the areas ci-ok lets it skip for", () => {
    expect(heavy.length).toBeGreaterThan(10);
    for (const [job, needed] of Object.entries(gates)) {
      const condition = jobs[job]?.if ?? "";
      for (const area of needed)
        expect(condition).toContain(`needs.changes.outputs.${area} == 'true'`);
    }
  });

  it("passes a docs-only pull request that ran only lint and the title check", () => {
    expect(
      passes("pull_request", areas([]), {
        lint: "success",
        "pr-title": "success",
        ...skipped(heavy),
      }),
    ).toBe(true);
  });

  it("passes a chart change that skipped the app's suites", () => {
    const ran = { lint: "success", "pr-title": "success", charts: "success", unit: "success" };
    const rest = skipped(heavy.filter((job) => !(job in ran)));
    expect(passes("pull_request", areas(["charts", "scripts"]), { ...rest, ...ran })).toBe(true);
  });

  it("fails an app change whose suites were skipped anyway", () => {
    expect(
      passes("pull_request", areas(["app"]), {
        lint: "success",
        "pr-title": "success",
        ...skipped(heavy),
      }),
    ).toBe(false);
  });

  it("fails when a job failed, or the changes job itself did", () => {
    expect(passes("pull_request", areas([]), { lint: "failure", ...skipped(heavy) })).toBe(false);
    const needs = { changes: { result: "failure", outputs: {} } };
    const result = Bun.spawnSync(["jq", "-e", "--arg", "event", "pull_request", program], {
      stdin: new TextEncoder().encode(JSON.stringify(needs)),
    });
    expect(result.exitCode).not.toBe(0);
  });
});

describe("ci.yml's end-to-end job", () => {
  it("turns the captcha on with Cloudflare's always-pass test keys, so its valid path runs", () => {
    const env = workflow("ci.yml").jobs.e2e?.env ?? {};
    expect(env.TURNSTILE_SITE_KEY).toBe("1x00000000000000000000AA");
    expect(env.TURNSTILE_SECRET_KEY).toBe("1x0000000000000000000000000000000AA");
  });
});
