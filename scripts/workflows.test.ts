/**
 * What the workflows in .github/workflows promise, read from the files themselves: who
 * gets which secrets, what runs when, and the rules every job follows (.claude/rules/ci.md).
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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
