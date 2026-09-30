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
