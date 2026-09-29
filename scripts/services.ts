/**
 * Starts and stops the local services (docker-compose.yml), without crowding out other
 * projects' containers on the same Docker:
 *
 *   bun run db:up          Postgres, Valkey, Mailpit
 *   bun run db:up:full     plus object storage and virus scanning (ClamAV, ~1.5 GB)
 *   bun run db:down        stop them (data is kept; `bun run docker:clean` deletes it)
 *   bun scripts/services.ts check [--full]   only report whether they'd fit
 *
 * Every service has a memory limit. Before starting, this adds up the limits of what's
 * about to start and checks they fit in Docker's memory next to what other containers
 * already use. If they don't, it starts nothing: running out of memory makes Docker kill
 * containers, and not necessarily ours.
 */
import { spawnSync } from "node:child_process";
import { fail, ok, ROOT, warn } from "./lib";

const PROJECT = "boilerplate";
/** Kept free for Docker itself and the growth of what's already running. */
const HEADROOM = 512 * 1024 ** 2;
const MB = 1024 ** 2;

function docker(args: string[]) {
  const result = spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const UNITS: Record<string, number> = {
  B: 1,
  KIB: 1024,
  MIB: MB,
  GIB: 1024 * MB,
  TIB: 1024 * 1024 * MB,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
};

/** Docker's "12.3MiB" / "1.2GiB" to bytes. */
function bytes(text: string) {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim());
  return match ? Number(match[1]) * (UNITS[match[2]?.toUpperCase() ?? ""] ?? 0) : 0;
}

function budget(profileArgs: string[]) {
  const config = docker(["compose", ...profileArgs, "config", "--format", "json"]);
  if (!config.ok) {
    fail("docker compose config");
    console.error(config.stderr);
    process.exit(1);
  }
  const services = (
    JSON.parse(config.stdout) as { services: Record<string, { mem_limit?: number | string }> }
  ).services;
  const running = new Set(
    docker(["compose", "ps", "--format", "{{.Service}}", "--status", "running"])
      .stdout.split("\n")
      .filter(Boolean),
  );
  const toStart = Object.entries(services).filter(([name]) => !running.has(name));
  const unlimited = toStart.filter(([, service]) => !service.mem_limit).map(([name]) => name);
  if (unlimited.length > 0) {
    fail(`every service needs a memory limit in docker-compose.yml: ${unlimited.join(", ")}`);
    process.exit(1);
  }
  // Compose reports limits in bytes, as a number or a numeric string.
  const needed = toStart.reduce((sum, [, service]) => sum + Number(service.mem_limit ?? 0), 0);

  const total = Number(docker(["info", "--format", "{{.MemTotal}}"]).stdout.trim());
  // What everything else uses right now (other projects' containers, and ours already up).
  const inUse = docker(["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}"])
    .stdout.split("\n")
    .filter(Boolean)
    .reduce((sum, line) => {
      const [, usage = ""] = line.split("\t");
      return sum + bytes(usage.split("/")[0] ?? "");
    }, 0);
  const free = total - inUse - HEADROOM;
  return { needed, free, total, inUse, starting: toStart.map(([name]) => name) };
}

const [command, flag] = process.argv.slice(2);
const profileArgs = flag === "--full" ? ["--profile", "full"] : [];

if (command === "up" || command === "check") {
  const { needed, free, total, inUse, starting } = budget(profileArgs);
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (needed > free) {
    fail(
      `Not starting ${starting.join(", ")}: they may use up to ${gb(needed)}, and Docker has ` +
        `${gb(Math.max(free, 0))} to spare (${gb(total)} in total, ${gb(inUse)} in use by running containers).`,
    );
    if (flag === "--full") {
      warn(
        "Start the core only (bun run db:up) with FILE_SCANNER=none, or give Docker more memory (Docker Desktop → Settings → Resources).",
      );
    } else {
      warn(
        "Give Docker more memory (Docker Desktop → Settings → Resources), or stop other containers.",
      );
    }
    process.exit(1);
  }
  if (starting.length > 0)
    ok(`${starting.join(", ")} fit in memory (up to ${gb(needed)} of ${gb(free)} free)`);
  if (command === "check") process.exit(0);
  const up = spawnSync("docker", ["compose", ...profileArgs, "up", "-d", "--wait"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  process.exit(up.status ?? 1);
} else if (command === "down") {
  const down = spawnSync("docker", ["compose", "--profile", "full", "down"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  process.exit(down.status ?? 1);
} else {
  console.error(
    `usage: bun scripts/services.ts up [--full] | check [--full] | down   (project "${PROJECT}")`,
  );
  process.exit(1);
}
