/**
 * Starts and stops the local services (docker-compose.yml), without crowding out other
 * projects' containers on the same Docker:
 *
 *   bun run db:up          Postgres, Valkey, Mailpit
 *   bun run db:up:mail     plus the Stalwart mail server (the prod-like email path)
 *   bun run db:up:full     plus that, object storage and virus scanning (ClamAV, ~1.5 GB)
 *   bun run db:down        stop them (data is kept; `bun run docker:clean` deletes it)
 *   bun scripts/services.ts check [--mail|--full]   only report whether they'd fit
 *
 * Every service has a memory limit. Before starting, this adds up the limits of what's
 * about to start and checks they fit in Docker's memory next to what other containers
 * already use. If they don't, it starts nothing: running out of memory makes Docker kill
 * containers, and not necessarily ours.
 */
import { fail, ok, ROOT, type Run, runSync, warn } from "./lib";

const PROJECT = "boilerplate";
/** Kept free for Docker itself and the growth of what's already running. */
const HEADROOM = 512 * 1024 ** 2;
const MB = 1024 ** 2;

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

/** What starting the profile needs and what Docker has; null (said why) when unknown. */
function budget(run: Run, profileArgs: string[]) {
  const docker = (args: string[]) => run("docker", args, { cwd: ROOT });
  const config = docker(["compose", ...profileArgs, "config", "--format", "json"]);
  if (config.status !== 0) {
    fail("docker compose config");
    console.error(config.stderr);
    return null;
  }
  const services = (
    JSON.parse(config.stdout) as {
      services: Record<string, { mem_limit?: number | string; restart?: string }>;
    }
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
    return null;
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
  // Setup steps (s3-init, stalwart-init) run once and exit, marked `restart: "no"`.
  const all = Object.entries(services);
  const oneShots = all.filter(([, service]) => service.restart === "no").map(([name]) => name);
  const longRunning = all.filter(([, service]) => service.restart !== "no").map(([name]) => name);
  return {
    needed,
    free,
    total,
    inUse,
    starting: toStart.map(([name]) => name),
    oneShots,
    longRunning,
  };
}

const PROFILES: Record<string, string> = { "--full": "full", "--mail": "mail" };

/**
 * Started without waiting for them to be healthy: ClamAV downloads its virus signatures
 * on a new volume (up to six minutes), and nothing else needs it to start. The worker
 * retries a scan until clamd answers, so uploads just stay pending meanwhile.
 */
const IN_BACKGROUND = new Set(["clamav"]);

/** `up`, `check` or `down`, with an optional profile flag; the exit code. */
export function services(argv = process.argv.slice(2), run = runSync): number {
  const [command, flag] = argv;
  const profile = flag ? PROFILES[flag] : undefined;
  if (flag && !profile) {
    console.error(`unknown flag ${flag}: use --mail or --full`);
    return 1;
  }
  const profileArgs = profile ? ["--profile", profile] : [];

  if (command === "down") {
    return (
      run("docker", ["compose", "--profile", "full", "down"], { cwd: ROOT, stdio: "inherit" })
        .status ?? 1
    );
  }
  if (command !== "up" && command !== "check") {
    console.error(
      `usage: bun scripts/services.ts up [--mail|--full] | check [--mail|--full] | down   (project "${PROJECT}")`,
    );
    return 1;
  }
  const plan = budget(run, profileArgs);
  if (!plan) return 1;
  const { needed, free, total, inUse, starting, oneShots, longRunning } = plan;
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
    return 1;
  }
  if (starting.length > 0)
    ok(`${starting.join(", ")} fit in memory (up to ${gb(needed)} of ${gb(free)} free)`);
  if (command === "check") return 0;
  // `up --wait` counts a container that exits as a failure, even with status 0, so the
  // setup steps run on their own once everything they depend on is up.
  const compose = (args: string[]) =>
    run("docker", ["compose", ...profileArgs, ...args], { cwd: ROOT, stdio: "inherit" }).status ??
    1;
  const background = longRunning.filter((name) => IN_BACKGROUND.has(name));
  const up = compose([
    "up",
    "-d",
    "--wait",
    ...longRunning.filter((name) => !IN_BACKGROUND.has(name)),
  ]);
  if (up !== 0) return up;
  for (const name of oneShots) {
    const status = compose(["run", "--rm", name]);
    if (status !== 0) return status;
  }
  if (background.length > 0) {
    warn(
      `Starting ${background.join(", ")} in the background: on a first start ClamAV downloads its virus signatures (up to 6 minutes), and uploads stay pending until it answers (\`docker compose logs -f clamav\`).`,
    );
    const status = compose(["up", "-d", ...background]);
    if (status !== 0) return status;
  }
  // Postgres runs its init files only on a new volume; the local read-only role (for the
  // Postgres MCP server) is safe to reapply, so a database made before it gets it too.
  const readonlyRole = compose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-q",
    "-U",
    "postgres",
    "-d",
    "app",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    "/docker-entrypoint-initdb.d/02-readonly-role.sql",
  ]);
  return readonlyRole;
}

if (import.meta.main) process.exit(services());
