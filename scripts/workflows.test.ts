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
