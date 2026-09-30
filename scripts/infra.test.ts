/**
 * The OpenTofu root's examples: every environment with a tfvars example has a backend
 * example of its own, with a state key of its own, so nobody copies staging's and points
 * production at staging's state.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT_DIR = join(import.meta.dir, "../infra/tofu/envs/k3s");
const environments = readdirSync(ROOT_DIR)
  .map((file) => /^(\w+)\.tfvars\.example$/.exec(file)?.[1])
  .filter((env): env is string => env !== undefined);

describe("infra/tofu/envs/k3s", () => {
  it("has tfvars examples", () => {
    expect(environments.sort()).toEqual(["production", "staging"]);
  });

  it.each(environments)("has a backend example for %s, with its own state key", (env) => {
    const backend = readFileSync(join(ROOT_DIR, `backend-${env}.hcl.example`), "utf8");
    expect(backend).toContain(`key        = "boilerplate/${env}.tfstate"`);
  });
});

describe("the facts OpenTofu writes on the cluster", () => {
  const main = readFileSync(join(ROOT_DIR, "main.tf"), "utf8");
  const block = /cluster_annotations = merge\(([\s\S]*?)\n {2}\)/.exec(main)?.[1] ?? "";
  const keys = [...block.matchAll(/"?([a-z][a-z0-9-]*)"?\s*=\s*(?:var|tostring|local|"|\w)/g)]
    .map((m) => m[1] as string)
    .filter((key) => !["var", "local"].includes(key));
  const readers = [
    ...readdirSync(join(import.meta.dir, "../deploy/argocd/appsets")).map(
      (f) => `deploy/argocd/appsets/${f}`,
    ),
    ...readdirSync(join(import.meta.dir, "../deploy/platform/addons"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => `deploy/platform/addons/${f}`),
  ]
    .map((file) => readFileSync(join(import.meta.dir, "..", file), "utf8"))
    .join("\n");

  it("writes annotations", () => {
    expect(keys).toContain("domain");
  });

  it.each(keys)("boilerplate.dev/%s is read by an ApplicationSet or an add-on", (key) => {
    const read =
      readers.includes(`boilerplate.dev/${key}`) ||
      new RegExp(`:\\s*${key}\\s*$`, "m").test(readers);
    expect(read).toBe(true);
  });
});
