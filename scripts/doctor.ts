/**
 * Checks that this machine can run the repo, and says exactly how to fix what can't.
 * Runs before `bun dev`; safe to run any time (`bun run doctor`). Never prints secrets.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { ENV_EXAMPLE_PATH, ENV_PATH, fail, ok, PLACEHOLDER, ROOT, readEnv, warn } from "./lib";

let problems = 0;
const problem = (message: string) => {
  problems += 1;
  fail(message);
};

async function version(command: string[]): Promise<string | null> {
  try {
    return (await $`${command}`.quiet().text()).trim();
  } catch {
    return null;
  }
}

console.log("\nTools");
const wantedNode = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();
const node = await version(["node", "--version"]);
if (!node) problem("Node is not installed. Install it with nvm: `nvm install` (reads .nvmrc).");
else if (!node.startsWith(`v${wantedNode}`))
  problem(`Node ${node} found, ${wantedNode} expected. Run \`nvm use\`.`);
else ok(`Node ${node}`);

ok(`Bun ${Bun.version}`);

const uv = await version(["uv", "--version"]);
if (uv) ok(uv);
else warn("uv is not installed (only needed for the Python service: `brew install uv`).");

const docker = await version(["docker", "info", "--format", "{{.ServerVersion}}"]);
if (docker) ok(`Docker ${docker}`);
else problem("Docker is not running. Start Docker Desktop (or your Docker daemon).");

console.log("\nEnvironment (.env)");
const env = readEnv(ENV_PATH);
const example = readEnv(ENV_EXAMPLE_PATH);
if (env.size === 0) problem("No .env yet. Run `bun run setup`.");
else {
  const missing = [...example.keys()].filter((key) => !env.has(key));
  const unknown = [...env.keys()].filter((key) => !example.has(key));
  const placeholders = [...env].filter(([, value]) => PLACEHOLDER.test(value)).map(([key]) => key);
  if (missing.length) problem(`Missing in .env (copy from .env.example): ${missing.join(", ")}`);
  if (unknown.length)
    warn(`In .env but not in .env.example (renamed or removed?): ${unknown.join(", ")}`);
  if (placeholders.length)
    problem(`Still set to a placeholder: ${placeholders.join(", ")}. Run \`bun run setup\`.`);
  if (!missing.length && !placeholders.length)
    ok(`${env.size} variables, in sync with .env.example`);
}

if (docker) {
  console.log("\nLocal services (docker compose)");
  const out = await version([
    "docker",
    "compose",
    "ps",
    "--format",
    "{{.Service}} {{.Health}} {{.State}}",
  ]);
  const running = new Map(
    (out ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [service = "", health = "", state = ""] = line.split(" ");
        return [service, health || state] as const;
      }),
  );
  for (const service of ["postgres", "valkey", "mailpit"]) {
    const status = running.get(service);
    if (status === "healthy" || status === "running") ok(`${service} ${status}`);
    else problem(`${service} is not running. Run \`bun run db:up\`.`);
  }

  if (running.get("postgres") === "healthy") {
    // A volume created before the role bootstrap existed has no service roles, and
    // every service would fail with "password authentication failed".
    const roles = await version([
      "docker",
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "app",
      "-Atc",
      "select count(*) from pg_roles where rolname in ('migrator','app_api','app_worker','app_notifications','app_webhooks','app_ai')",
    ]);
    if (roles === "6") ok("database roles bootstrapped");
    else
      problem(
        "Database roles are missing (volume predates infra/postgres/init). Recreate it: `docker compose down -v && bun run setup` (this deletes local data).",
      );
  }
}

console.log(problems ? `\n${problems} problem(s) found.\n` : "\nAll good.\n");
process.exit(problems ? 1 : 0);
