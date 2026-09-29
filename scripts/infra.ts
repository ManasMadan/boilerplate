/**
 * Checks the OpenTofu code the way CI does: `bun run infra:check`.
 *
 *   1. `tofu fmt -check` over infra/tofu;
 *   2. every module and environment root: init (no backend), validate, and its tests
 *      (`tofu test`, against mocked providers: nothing is created or connected to).
 *
 * Needs `tofu` (the version CI pins in .github/workflows/ci.yml, or the devcontainer).
 * Providers are downloaded once into the plugin cache.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, ROOT } from "./lib";

const TOFU = join(ROOT, "infra/tofu");
const PLUGIN_CACHE = join(ROOT, "node_modules/.cache/tofu-plugins");
mkdirSync(PLUGIN_CACHE, { recursive: true });

function tofu(args: string[], cwd: string) {
  const result = spawnSync("tofu", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE, TF_IN_AUTOMATION: "1" },
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

let failed = false;
function check(label: string, result: { ok: boolean; output: string }) {
  if (result.ok) {
    ok(label);
    return true;
  }
  failed = true;
  fail(label);
  console.error(result.output.trim());
  return false;
}

check("tofu fmt", tofu(["fmt", "-check", "-recursive", "-diff", "."], TOFU));

const roots = [
  ...readdirSync(join(TOFU, "modules")).map((name) => `modules/${name}`),
  ...readdirSync(join(TOFU, "envs")).map((name) => `envs/${name}`),
];
for (const root of roots.sort()) {
  const dir = join(TOFU, root);
  if (!check(`${root}: init`, tofu(["init", "-backend=false", "-input=false", "-no-color"], dir))) {
    continue;
  }
  check(`${root}: validate`, tofu(["validate", "-no-color"], dir));
  if (existsSync(join(dir, "tests"))) check(`${root}: tests`, tofu(["test", "-no-color"], dir));
}

process.exit(failed ? 1 : 0);
